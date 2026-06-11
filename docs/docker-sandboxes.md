---
title: Docker Sandboxes (Container Architecture)
created: 2026-06-11
last_updated: 2026-06-11
---

# Docker Sandboxes (Container Architecture)

This document describes how NanoClaw uses Docker containers to run agents in isolation. It is the user-facing reference for container behaviour. For build mechanics, image channels, and the promotion workflow, see [`container/VERSIONING.md`](../container/VERSIONING.md).

## Overview

NanoClaw is a single Node.js host process. When a message needs a response, the host spawns a **per-session Linux container** running the Claude Agent SDK, waits for it to finish, and routes the reply back through the channel adapter.

Each container:

- Runs as a non-root user (`node`) inside a Linux VM or `node:22-slim`-based image.
- Has its own writable group folder (bind-mounted from the host).
- Receives its initial prompt via **stdin JSON** and emits its reply on **stdout JSON**.
- Has no real credentials — the host injects them on demand through a local proxy (see [Credential Proxy](#credential-proxy)).
- Can be recycled between messages; sessions persist across container restarts as JSONL transcripts plus a `session_id` stored in PostgreSQL.

Containers are **not** one-per-message. They stay alive between turns (idle-polling for IPC follow-ups) and time out after 30 minutes of inactivity. The next message after a timeout spawns a new container that resumes the same SDK session.

## Image Architecture

The image (`nanoclaw-agent:<version>`, see [Channels](#channels--versioning)) is built from `container/Dockerfile`. It contains:

| Component | Source | Notes |
|-----------|--------|-------|
| Base image | `node:22-slim` (pinned) | Linux runtime |
| System packages | apt (Dockerfile) | Chromium, fonts, `libgbm1`, `libnss3`, etc. — required for browser automation |
| `claude-code` CLI | npm global, pinned | `@anthropic-ai/claude-code@<pinned version>` — must match SDK parity version |
| Agent-runner deps | `container/agent-runner/package.json` + lockfile | `package.json` is baked; `src/` is mounted (see below) |
| Agent-runner compiled output (`dist/`) | `container/agent-runner/` | **Overwritten at runtime** by the per-spawn mount of `src/` + `tsc` recompile |
| `brave-search` MCP server | `container/mcp-servers/brave-search/` | dist baked into image |
| `nanoclaw-web-search` MCP server | `container/mcp-servers/nanoclaw-web-search/` | dist baked into image |
| `nanoclaw-transcription` MCP server | `container/mcp-servers/nanoclaw-transcription/` | dist baked into image |
| Workspace scaffolding | Dockerfile `mkdir` | `/workspace/group`, `/workspace/extra`, `/workspace/ipc/{messages,tasks,input}` |
| Entrypoint script | inline | `npx tsc --outDir /tmp/dist && node /tmp/dist/index.js` — recompiles per-spawn from mounted `src` |

The entrypoint reads a single JSON object from stdin and writes a single JSON object to stdout. Follow-up messages and host commands arrive as files in `/workspace/ipc/input/`; the agent watches the directory while idle.

### What is NOT baked in

The following are mounted, copied, or injected at runtime, so changes do **not** require a rebuild:

- **`container/agent-runner/src/`** — copied into `data/sessions/<group>/agent-runner-src/` and mounted over `/app/src` (rw). Entrypoint recompiles to `/tmp/dist` on every spawn. This is the single most counter-intuitive thing in the container model: edits to `container/agent-runner/src/**` take effect on the **next** container run, with no image rebuild or version bump.
- Group folder (`<group>/CLAUDE.md`, `MEMORY.md`, daily notes, etc.) — bind-mounted as `/workspace/group` (rw).
- Per-group session dir + `settings.json` — written per-spawn into `data/sessions/<folder>/.claude` and mounted as `/home/node/.claude` (rw). `settings.json` is **auto-generated** from the resolved preset; do not edit it manually.
- Skills — copied per-spawn from `container/skills/` (filtered by `containerConfig.skills`).
- Extracted skills — copied from `group/memory/extracted_skills/` when `learningLoop === true`.
- Group IPC dir — `data/ipc/<folder>/` mounted as `/workspace/ipc` (rw).
- `agent-browser` native binary — host-resolved per arch from `container/binaries/agent-browser/`, mounted at `/usr/local/lib/node_modules/agent-browser` and `/usr/local/bin/agent-browser`. Only mounted when the group explicitly lists `agent-browser` in its `skills`.
- All `containerConfig` field values — read per-spawn from PostgreSQL and passed as env vars (`NANOCLAW_TOOL_ALLOWLIST`, `NANOCLAW_DENIED_TOOLS`, `NANOCLAW_APPROVAL_MODE`, `NANOCLAW_NATIVE_WEB_TOOLS`, etc.).
- All credentials and channel tokens — never baked; the credential proxy injects them at request time.
- Additional mounts from `containerConfig.additionalMounts` — validated against `~/.config/nanoclaw/mount-allowlist.json` by `src/mount-security.ts` before being attached.

See `container/VERSIONING.md` § "Baked-In Components" and § "Runtime-Injected Components" for the full classification.

## Container Lifecycle

Spawn happens in `src/container-runner.ts`. For each turn:

1. **Resolve group config** — read `containerConfig` from PostgreSQL, merge with preset defaults, validate.
2. **Resolve auth mode** — `detectAuthMode()` decides whether to inject an `x-api-key` placeholder (API-key mode) or an OAuth placeholder (OAuth mode). The proxy swaps the placeholder for the real credential.
3. **Resolve image tag** — `resolveImageTag(group.containerChannel)` maps the group's channel (`stable` / `next` / per-group override) to a versioned tag from `container/VERSIONS.json`.
4. **Prepare writable session dir** — `data/sessions/<folder>/.claude/` is populated with a fresh `settings.json` (auto-compaction from preset), filtered skills, and (when `learningLoop === true`) extracted skills.
5. **Copy agent-runner source** — `container/agent-runner/src/` is `fs.cpSync`'d into `data/sessions/<folder>/agent-runner-src/`.
6. **Build `docker run` args** — mounts for `/workspace/group`, `/workspace/ipc`, `/home/node/.claude`, the per-spawn `src` overlay, additional validated mounts, and per-arch `agent-browser` mounts when applicable. Environment variables carry `ANTHROPIC_BASE_URL`, the tool-allowlist ceiling, denied tools, approval mode/timeout, command allowlist, write-mounts, web-search config, native web-tools toggle, and any `containerConfig.additionalMounts`-derived env. `--init` is set so the child reaps its own zombies.
7. **Spawn** — `docker run -i --rm` with the JSON prompt piped to stdin. The host reads stdout JSON, parses the final assistant message and any tool activity, and routes the reply.
8. **Recycle** — on the next message, the host re-uses the persisted `session_id` to resume the same SDK session. If the container has idle-timed out (default 30 min) or hit the `containerConfig.timeout` (default 5 min for the active run), a new container is spawned against the same session JSONL.

The runtime also exposes a `cleanupOrphans()` pass that stops containers matching the `nanoclaw-` prefix, excluding the host's own hostname so the host process is never killed by accident.

## Credential Proxy

Containers never see real API keys or channel tokens. The host runs a local HTTP server (`src/credential-proxy.ts`) that proxies all upstream traffic and injects the real credential from `~/.config/nanoclaw/secrets.env`.

- **Default bind:** `127.0.0.1:3001` (override with `CREDENTIAL_PROXY_PORT` env).
- **Container-facing URL:** `http://host.docker.internal:3001` (set as `ANTHROPIC_BASE_URL` per spawn).
- **Endpoint routing:** the proxy reads the `X-Nanoclaw-Endpoint` request header and routes to the matching vendor's upstream (`{VENDOR}_BASE_URL`) with its credentials (`{VENDOR}_API_KEY`, optional `{VENDOR}_AUTH` mode, optional `{VENDOR}_REGION` for SigV4/Bedrock).
- **Auth modes:** `x-api-key` (default), `bearer` (OAuth), `sigv4` (AWS-style). Selected per vendor in `secrets.env`.
- **Web search:** the `X-Nanoclaw-Web-Search-Vendor` header selects the vendor for the web search MCP tool.
- **Transforms:** the `X-Nanoclaw-Transform` header triggers bidirectional Anthropic ↔ OpenAI ChatCompletions translation in the proxy — required for open-source models (e.g. on the Bedrock `bedrockoss` endpoint).

Containers see only a placeholder key (e.g. `placeholder` or `proxy-managed`). The proxy is the only component that touches the real credential.

See [`credential-proxy.md`](credential-proxy.md) for the full reference, including multi-vendor routing, Bedrock `sdkMode: "bedrock"`, and the Mantle proxy strip-list.

## Networking

Container-to-host traffic uses `host.docker.internal`:

- **Credential proxy:** `http://host.docker.internal:3001` (set as `ANTHROPIC_BASE_URL`)
- **IPC:** file-based — containers watch `/workspace/ipc/input/` for follow-up messages and host commands, and write outbound IPC into `/workspace/ipc/messages/` and `/workspace/ipc/tasks/`.

On Linux, `host.docker.internal` is provided automatically by Docker Desktop / Docker Engine. On Apple Silicon macOS using Apple's `container` CLI, you must configure `vmnet` networking so containers can reach the host gateway — see [`apple-container-networking.md`](apple-container-networking.md).

The `ANTHROPIC_BASE_URL` env var means containers route all model API traffic through the proxy. Direct upstream calls are not possible because containers have no real credentials.

## Channels & Versioning

Agent containers use a channel-based image system. There is no `:latest` tag.

| Channel | Tag | Purpose |
|---------|-----|---------|
| `stable` | `nanoclaw-agent:stable` | Default. All groups use this unless explicitly switched. |
| `next` | `nanoclaw-agent:next` | Canary. Test new SDK/CLI versions on a single group before promotion. |

Both `:stable` and `:next` are mutable `docker tag` aliases pointing at immutable versioned tags (`nanoclaw-agent:v1.0.0`, etc.). Versioned tags are never overwritten.

Each group has a `container_channel` column on `registered_groups` (default `'stable'`). The host resolves this to an image tag at spawn time via `container/VERSIONS.json`.

Per-group channel switching (host commands, not doc edits):

```
/version next     # switch this group to :next
/version stable   # switch back to :stable
/version          # show current channel, image SHA, and version
```

Channel switches take effect on the next container spawn — running containers are unaffected until recycled. When an SDK major-line boundary is crossed (e.g. 0.2.x → 0.3.x), session JSONL is not backward-resumable; users must run `/newsession` after switching channels.

Full reference: [`container/VERSIONING.md`](../container/VERSIONING.md) — covers `VERSIONS.json`, the rebuild classification matrix, promotion checklist, and rollback procedure.

## Build Commands

All container image work goes through `container/scripts/container.sh`. Do not use `docker build` directly.

```bash
# Build a new versioned image (does NOT change any channel)
./container/scripts/container.sh build v1.2.0

# Point :next at the new build (canary on opt-in groups)
./container/scripts/container.sh stage v1.2.0

# Promote to :stable (affects all groups) — manual decision point
./container/scripts/container.sh promote v1.2.0

# Revert :stable to its previous versioned tag
./container/scripts/container.sh rollback

# Show current channel state
./container/scripts/container.sh current
```

Bare `container/build.sh` invocations are rejected — the script requires an explicit version tag. After every `build`/`stage`/`promote`/`rollback`, the script updates `container/VERSIONS.json` atomically. Commit the file to preserve the audit trail.

**When you do (and do not) need to rebuild** — see the classification matrix in `container/VERSIONING.md` § "Full Classification Matrix". Short version: changes to `container/agent-runner/src/**`, `container/skills/**`, `tool-allowlist.json`, `containerConfig`, and host code (`src/**`) do **not** require a rebuild. Changes to `container/Dockerfile`, `container/agent-runner/package.json` (or its lockfile), or any MCP server `src/` **do** require a rebuild + version bump.

## Cross-References

- [`container/VERSIONING.md`](../container/VERSIONING.md) — channels, `VERSIONS.json`, promotion, rollback
- [`apple-container-networking.md`](apple-container-networking.md) — Apple `container` CLI vmnet setup on macOS
- [`credential-proxy.md`](credential-proxy.md) — multi-vendor routing, auth modes, transforms
- [`security.md`](security.md) — mount security, injection scanning, command approval
- [`spec.md`](spec.md) — message flow, IPC types, session lifecycle
