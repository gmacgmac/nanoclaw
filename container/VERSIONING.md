# Container Versioning & Channels

> Source of truth: `VERSIONS.json` (this directory)
> Tooling: `scripts/container.sh`

---

## Concepts

| Term | Meaning |
|------|---------|
| **Versioned tag** | Immutable. `nanoclaw-agent:v1.0.0` is never overwritten. A build produces exactly one versioned tag. |
| **Channel alias** | Mutable pointer. `:stable` and `:next` are `docker tag` aliases that point at a versioned tag. |
| `:stable` | Default channel. All groups use this unless explicitly switched to `:next`. |
| `:next` | Canary channel. Used for testing new SDK/CLI versions on a single group before promotion. |
| `VERSIONS.json` | Git-tracked state file recording which version each channel points at, plus metadata for every built version. |

---

## Why No `:latest`

The `:latest` tag is **not used** in this system. Problems it caused:

1. Silent drift — two builds a week apart ship different CLI versions with no source change.
2. No rollback target — once overwritten, the previous image is unrecoverable without layer SHAs.
3. Ambiguity — `docker pull` defaults to `:latest`, masking which version is actually running.

`build.sh` now errors if called without an explicit version tag.

---

## Daily Commands

```bash
# See what's running
./scripts/container.sh current

# List all known versions
./scripts/container.sh list

# Build a new version (does NOT change any channel)
./scripts/container.sh build v1.2.0

# Point :next at the new build (canary)
./scripts/container.sh stage v1.2.0

# After testing, promote to :stable (affects all groups)
./scripts/container.sh promote v1.2.0

# Something went wrong — roll :stable back
./scripts/container.sh rollback
```

---

## Do I Need to Rebuild?

> **Read this first.** It answers the question in under 30 seconds.

```
Changed Dockerfile or apt packages?                            → YES, rebuild
Changed container/agent-runner/package.json or lockfile?       → YES, rebuild
Changed claude-code CLI version (Dockerfile line 36)?          → YES, rebuild + new version tag
Changed MCP server source (container/mcp-servers/*)?            → YES, rebuild (dist is baked)
Added a NEW MCP server?                                        → YES, rebuild (needs new COPY + RUN)
Changed container/agent-runner/src/*?                          → NO  (mounted per-spawn)
Changed container/agent-runner/tsconfig.json?                  → NO* (mounted; verify compile output)
Changed container/skills/*?                                    → NO  (copied per-spawn)
Changed container/binaries/agent-browser/*?                    → NO  (host-mount at spawn)
Changed tool-allowlist.json?                                   → NO  (read per-spawn via env)
Changed env vars / secrets.env on host?                        → NO  (injected per-spawn)
Changed group containerConfig (existing field)?                → NO  (host reads per-spawn)
Added a new containerConfig field read by host only?           → NO  (host only)
Added a new containerConfig field read by agent-runner?        → DEPENDS (likely NO; verify)
Changed src/container-runner.ts (host spawn logic)?            → NO  (host only; restart host)
Edited VERSIONS.json channels manually?                        → NO  (no image change)
```

> [!TIP]
> **`container/agent-runner/src/**` is the biggest exception to the "anything in `container/` needs a rebuild" rule.** `container-runner.ts` copies the source tree into a per-group writable location on every spawn, then mounts it over `/app/src`. The container's entrypoint runs `npx tsc --outDir /tmp/dist` on every spawn. Edits take effect on the **next** container run — no rebuild, no version bump.
>
> Verify this holds by checking `repo/src/container-runner.ts` mount logic if the codebase has changed since this doc was written.

If the answer is YES, also run through [Promotion Checklist](#promotion-checklist) and the [SDK Update Chain](#sdk-update-chain) sections below.

---

## Baked-In Components

Anything below is `COPY`'d or `RUN`-installed during `docker build`. A change to **any** of these requires a rebuild.

| Component | Source path | Dockerfile line | Notes |
|-----------|-------------|-----------------|-------|
| Base image | `node:22-slim` (pinned) | 4 | Pulled at build time |
| System packages (chromium, fonts, libgbm, libnss, …) | apt | 9-29 | Browser runtime |
| `claude-code` CLI (pinned) | npm | 36 | `@anthropic-ai/claude-code@2.1.147` |
| Agent-runner deps | `container/agent-runner/package.json` + lock | 42-45 | `package.json` IS baked; `src/` is mounted (see below) |
| Agent-runner compiled output (`dist/`) | `container/agent-runner/` | 48-51 | Overwritten at runtime by mount |
| `brave-search` MCP server | `container/mcp-servers/brave-search/` | 54-55 | `/app/mcp-servers/brave-search/dist/index.js` |
| `nanoclaw-web-search` MCP server | `container/mcp-servers/nanoclaw-web-search/` | 58-59 | `/app/mcp-servers/nanoclaw-web-search/dist/index.js` |
| `nanoclaw-transcription` MCP server | `container/mcp-servers/nanoclaw-transcription/` | 62-63 | `/app/mcp-servers/nanoclaw-transcription/dist/index.js` |
| Workspace dir scaffolding | (none — created empty) | 66 | `/workspace/group`, `/workspace/extra`, `/workspace/ipc/{messages,tasks,input}` |
| Entrypoint script | inline | 72 | `npx tsc --outDir /tmp/dist` then `node /tmp/dist/index.js` — recompiles per-spawn from mounted `src` |
| Image version label | inline | 6 | `org.opencontainers.image.version` — must match `VERSIONS.json` entry |

### Adding a new MCP server

Adding a **fourth** MCP server requires editing the Dockerfile:

1. Add a new `COPY container/mcp-servers/<name>/ /app/mcp-servers/<name>/` block
2. Add a `RUN cd /app/mcp-servers/<name> && npm install && npm run build` block
3. Add the server entry to the group(s) in `containerConfig.mcpServers`
4. Rebuild and version-bump normally

> Editing the *source* of an existing MCP server (`container/mcp-servers/<existing>/src/**`) is also a rebuild — its `dist/` is baked into the image.

---

## Runtime-Injected Components (NO rebuild)

> [!IMPORTANT]
> **`container/agent-runner/src/**` is in this category.** This is the single most counter-intuitive thing in the container model. The host `fs.cpSync`'s the directory on every spawn and mounts it over `/app/src` (rw). The container entrypoint recompiles from there into `/tmp/dist`. Edits take effect on the next container run without a rebuild or version bump.

| Component | Injection method | Source / destination |
|-----------|------------------|----------------------|
| Group folder | `-v` bind mount | `resolveGroupFolderPath(group.folder)` → `/workspace/group` (rw) |
| Group sessions dir + `settings.json` | per-spawn `fs.writeFileSync` | `DATA_DIR/sessions/<folder>/.claude` → `/home/node/.claude` (rw) |
| Skills (filtered by `containerConfig.skills`) | per-spawn `fs.cpSync` (cleared + recopied) | `container/skills/` → `sessions/<folder>/.claude/skills` (rw) |
| Extracted skills (when `learningLoop === true`) | per-spawn `fs.copyFileSync` | `group/memory/extracted_skills/` → `skills/extracted/` |
| Group IPC dir | `-v` bind mount (created) | `DATA_DIR/ipc/<folder>/` → `/workspace/ipc` (rw) |
| **Agent-runner source** | `fs.cpSync` per-spawn, then mounted over `/app/src` (rw) — entrypoint recompiles to `/tmp/dist` | `container/agent-runner/src/` → `/app/src` (rw) |
| `agent-browser` native binary (host arch) | `-v` bind mounts (ro) | `container/binaries/agent-browser/` + `bin/agent-browser-<arch>` → `/usr/local/lib/node_modules/agent-browser` + `/usr/local/bin/agent-browser` |
| Tool allowlist ceiling | `-e NANOCLAW_TOOL_ALLOWLIST=...` per-spawn (fresh `loadToolAllowlist()`) | `repo/tool-allowlist.json` |
| Per-group denied tools | `-e NANOCLAW_DENIED_TOOLS=...` | `group.containerConfig.deniedTools` |
| Anthropic auth (`x-api-key` placeholder vs OAuth) | `-e` per-spawn | derived from host `detectAuthMode()` |
| Credential-proxy URL, endpoint name | `-e` per-spawn | always |
| `BRAVE_SEARCH_API_KEY` | `-e` per-spawn, only when `mcpServers.brave-search` is set | host `secrets.env` |
| `NANOCLAW_WEB_SEARCH_VENDOR`, `NANOCLAW_PROXY_HOST/PORT`, `NANOCLAW_SSRF_CONFIG` | `-e` per-spawn, only when web-search MCP enabled | group + preset |
| `NANOCLAW_APPROVAL_MODE` + `NANOCLAW_APPROVAL_TIMEOUT` + `NANOCLAW_COMMAND_ALLOWLIST` + `NANOCLAW_WRITE_MOUNTS` | `-e` per-spawn | group `containerConfig.approvalMode*` |
| `NANOCLAW_NATIVE_WEB_TOOLS` | `-e` per-spawn | preset capability |
| `TZ`, `ANTHROPIC_BASE_URL`, host gateway args | `-e` per-spawn | host config |
| Additional mounts | `-v` per-spawn, validated by `mount-security.ts` | `group.containerConfig.additionalMounts` |
| Image tag selection (`stable` vs `next` vs group override) | `resolveImageTag(group.containerChannel)` | `VERSIONS.json` channels |

---

## Full Classification Matrix

| Change type | Rebuild required | Confidence | Notes |
|-------------|------------------|------------|-------|
| Edit `repo/container/Dockerfile` | YES | High | Always |
| Bump base image (e.g. `node:22-slim` → `node:24-slim`) | YES | High | Apt layer changes too |
| Add/remove apt package | YES | High | Dockerfile line 9-29 |
| Bump `claude-code` CLI in Dockerfile (line 36) | YES + new version tag + `VERSIONS.json` + `stage`/`promote` | High | See [Promotion Checklist](#promotion-checklist) |
| Bump `@anthropic-ai/claude-agent-sdk` or any other npm dep in `container/agent-runner/package.json` | YES + version tag | High | Lockfile changes also force `npm install` re-run |
| Edit `container/agent-runner/src/**` | **NO** | High | Mounted + recompiled per-spawn |
| Edit `container/agent-runner/tsconfig.json` | NO* | Medium | Files re-mounted; `tsc` picks it up. If it changes compile output structure, behaviour may shift without a build bump. |
| Add new MCP server source under `container/mcp-servers/<name>/` | YES | High | Must add `COPY` + `RUN` lines to Dockerfile |
| Edit code in an existing MCP server (`container/mcp-servers/<existing>/src/**`) | YES | High | MCP dist files are baked in |
| Change MCP server args/command in `group.containerConfig.mcpServers` (e.g. add `--flag`) | NO | High | `mcpServers` is per-spawn env in `buildContainerInput` |
| Add new `containerConfig` field that the host already understands (e.g. `deniedTools`, `commandAllowlist`) | NO | High | Read per-spawn, injected as env vars |
| Add new `containerConfig` field that the AGENT needs to read | **DEPENDS** | Medium | If agent-runner reads it from env → NO rebuild. If agent-runner hard-codes a default and the field requires a new env name → likely YES. No automated detection. |
| New `containerConfig` field consumed only by host logic (e.g. new `additionalMounts` validator) | NO | High | Host-only |
| `tool-allowlist.json` edits | NO | High | Per-spawn read |
| `src/config.ts` `VERIFIED_CATALOG` array edits | NO | High | Host fallback; effective on next host restart |
| `container/agent-runner/src/index.ts` `FALLBACK_CATALOG` array edits | NO | Medium | Same as agent-runner-src — no rebuild |
| Skills code under `container/skills/<name>/` | NO | High | Filtered by `group.containerConfig.skills` |
| Skill `SKILL.md` frontmatter / `name` change | NO | High | Same as above |
| `container/binaries/agent-browser/**` (native binary) | NO | High | Per-arch variant is host-resolved |
| `src/container-runner.ts` (host spawn logic) | NO | High | Not in image; restart host |
| `src/credential-proxy.ts`, `src/mount-security.ts`, `src/multi-agent-router.ts` | NO | High | Host side |
| Channel/route defaults in `src/build-container-input.ts` | NO | High | Host side |
| `setup/*.ts` (post-install setup scripts) | NO | High | Never runs inside container |
| `.env` / `secrets.env` host values (e.g. `BRAVE_SEARCH_API_KEY`, `TELEGRAM_*_BOT_TOKEN`) | NO | High | Injected as env, never baked |
| Per-group CLAUDE.md / prompt / context files | NO | High | Lives on host |
| Schedule task JSON files under IPC dirs | NO | High | Per-group data |
| `VERSIONS.json` edits | NO | High | Channels are just `docker tag` aliases |
| Tagging a previously built image (e.g. `docker tag ... v1.2.0`) | NO | High | Re-tagging is a metadata op |

> If you encounter a change type not covered here, check the [Baked-In Components](#baked-in-components) and [Runtime-Injected Components](#runtime-injected-components-no-rebuild) sections. Anything not on the runtime list is baked in.

---

## The `VERSIONS.json` File

Located at `repo/container/VERSIONS.json`. Structure:

```json
{
  "channels": { "stable": "v1.0.0", "next": "v1.0.0" },
  "versions": {
    "v1.0.0": {
      "imageId": "sha256:...",
      "builtAt": "ISO-8601",
      "sdkVersion": "0.2.76",
      "cliVersion": "2.1.147",
      "notes": "..."
    }
  },
  "history": []
}
```

- **`channels`**: current pointer for each alias.
- **`versions`**: metadata per immutable build.
- **`history`**: append-only log of promote/rollback operations.

This file is git-tracked. After any `promote`, `stage`, or `rollback`, the file is updated atomically. Commit it to preserve the audit trail.

---

## Promotion Checklist

Before running `container.sh promote <version>`:

1. [ ] The version has been staged as `:next` and tested on at least one group.
2. [ ] Session resume works both directions (`:stable` → `:next` → `:stable`), or the `/newsession` workaround is documented.
3. [ ] All host-side tests pass against the new image.
4. [ ] The rollback target is known (`container.sh current` shows the current `:stable`).
5. [ ] You have explicit user approval (MANUAL_01 decision point).

---

## Session Compatibility Across SDK Versions

> [!IMPORTANT]
> **`/newsession` is required when switching channels between v1.0.0 and v1.1.0+ (any version crossing the 0.2.x → 0.3.x SDK boundary).**

When the underlying Claude Agent SDK version changes between two channels, the session JSONL format can drift in ways that confuse the resuming model. Observed symptoms during the v1.0.0 → v1.2.0 canary:

- Model routes user-facing content into `thinking` blocks instead of `text` blocks
- The `result` event from the SDK comes back empty, so Telegram receives nothing
- Tool-use sequencing appears malformed in the resumed session

**Cause:** v1.0.0 ships SDK `0.2.76`. v1.1.0+ ships SDK `0.3.147`. The 0.2.x → 0.3.x JSONL format changes (thinking block structure, signature fields, content typing) are not backward-resumable.

**Required workaround:** after switching channels with `/version stable` or `/version next` across this boundary, run `/newsession` before sending the next user message. The old session JSONL is preserved on disk.

**Same-major-line (0.3.x → 0.3.x):** session resume works cleanly without `/newsession`. Verified across v1.1.0 → v1.2.0 → v1.21.0 → v1.22.0 → v1.23.0 (all SDK 0.3.147). If a future build upgrades to 0.4.x or higher, re-evaluate and update this section.

---

## SDK Update Chain

When the SDK version changes (e.g. 0.3.x → 0.4.x), the cascade is:

1. **Bump `container/agent-runner/package.json`** → forces a rebuild (lockfile + dist are baked).
2. **`container.sh build vX.Y.Z`** with the new `package.json` → creates a new image and records SDK/CLI versions into `VERSIONS.json` automatically.
3. **Session compatibility check** above — if the SDK crosses a major-line boundary, `/newsession` is required on every group when channels change.
4. **Tool catalog rediscovery** — new SDK versions may add/remove built-in tools. Follow `repo/docs/sdk-tool-catalog-rediscovery.md` to probe the new catalog and update `repo/tool-allowlist.json`, `src/config.ts` `VERIFIED_CATALOG`, and `container/agent-runner/src/index.ts` `FALLBACK_CATALOG`. This step is manual — there is no automation that detects catalog drift.
5. **`stage`** → canary on a single group.
6. **`promote`** → all `:stable` groups; [Promotion Checklist](#promotion-checklist) must be satisfied.

> **After any SDK version bump, also run the tool catalog rediscovery process — see `repo/docs/sdk-tool-catalog-rediscovery.md`.**

---

## Rollback Procedure

```bash
# Automatic (uses history from VERSIONS.json)
./scripts/container.sh rollback

# Manual (if history is corrupted or missing)
docker tag nanoclaw-agent:v1.0.0 nanoclaw-agent:stable
# Then fix VERSIONS.json channels.stable manually
```

After rollback, groups on `:stable` will pick up the reverted image on their next container spawn. Running containers are not affected until recycled.

---

## Cross-References

- `repo/CLAUDE.md` — references this file for in-container agents
- `.agent/rules/nanoclaw-versioning.md` — agent steering for version conventions
- `repo/docs/docker-sandboxes.md` — user-facing container documentation
- `repo/docs/sdk-tool-catalog-rediscovery.md` — tool catalog refresh process (called out from [SDK Update Chain](#sdk-update-chain))
