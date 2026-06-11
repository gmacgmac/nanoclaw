# NanoClaw

Personal Claude assistant. See [README.md](README.md) for setup, architecture, and security configuration. See [docs/requirements.md](docs/requirements.md) for architecture decisions.

## RULES

1. We opt for Concise Code
2. We try to avoid over engineering as much as possible
3. We try to re-use code and patterns as much as possible
4. We strategise plans
5. We do not assume that a "question" requires an action. The user will indicate if action must be taken.
6. When coding, be very mindful of the depth of the application for which you might be adding features. Consider if "this" culd be a breaking change.

## CONFIRMATION PROTOCOL:

1. If I ask for a "strategy", "plan", "review", or "investigation", you must output TEXT ONLY.
2. You are STRICTLY FORBIDDEN from modifying ANY files or making ANY changes until I explicitly give permission to proceed.
3. If you formulate a plan, you must STOP and ask: "Shall I proceed with this implementation?"
4. NEVER assume implied consent. If the prompt does not explicitly order code changes, DO NOT touch the file system.


## Safety Note

You are FORBIDDEN from reading secrets.env

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in isolated Docker containers. Each group has its own filesystem, session state, and memory. Credentials never reach containers — a host-side proxy injects them at request time. Per-group behaviour is controlled via `containerConfig` stored in PostgreSQL.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals, proxy port |
| `src/container-runner.ts` | Spawns agent containers with mounts and per-group config |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | PostgreSQL operations via postgres.js (messages, groups, sessions, tasks, errors) |
| `src/credential-proxy.ts` | Host-side API proxy — injects real credentials into container requests |
| `src/cursor-state.ts` | Composite cursor (`{ts, id}`) state — global & per-group cursors, persistence via `router_state`, legacy migration, recovery |
| `src/group-queue.ts` | Per-group FIFO queue with global concurrency limit |
| `src/mount-security.ts` | Mount allowlist validation for container volumes |
| `src/env.ts` | Environment variable loading from secrets.env and .env |
| `src/aws-sigv4.ts` | Pure-function SigV4 request signer (Node crypto, zero deps) |
| `src/aws-credentials.ts` | Host-side AWS credential provider chain (static-env → container-creds → IMDSv2) |
| `src/logger.ts` | Built-in logger with DB error wrapper |
| `src/types.ts` | TypeScript interfaces (ContainerConfig, Channel, RegisteredGroup) |
| `src/nightly-maintenance.ts` | Nightly cron: nudge, prune messages, expire delegations, rotate logs |
| `src/prompt-reminders.ts` | Prompt reminder resolver — loads `docs/hooks/` snippets, interpolates channel |
| `src/host-commands.ts` | Host commands (/model, /version, /newsession, /shutdown, /stop, /context) |
| `store/messages.db` | **Legacy artifact** — no longer the primary store. Data lives in PostgreSQL (Docker volume `pgdata`, container `nanoclaw-postgres-1`) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `docs/hooks/` | Per-turn reminder snippets (loaded by `src/prompt-reminders.ts`) |
| `container/skills/` | Skills loaded inside agent containers |
| `container/agent-runner/src/index.ts` | Agent entry point inside containers (SDK invocation) |

## Host-Side Development (This Chat)

When working in Claude Code CLI on the host (this context), write memories to this CLAUDE.md file, not to `~/.claude/projects/` auto-memory. The auto-memory system is machine-specific and not portable. Group chats use their own memory system inside containers (`groups/{name}/CLAUDE.md` + `data/sessions/{group}/memory/`).

Query the database with: `docker compose exec postgres psql -U nanoclaw nanoclaw`

### DB Schema (source of truth: `src/db.ts`)

| Table | Columns |
|-------|---------|
| `chats` | `jid` (PK), `name`, `last_message_time`, `channel`, `is_group` |
| `messages` | `id`, `chat_jid`, `sender`, `sender_name`, `content`, `timestamp`, `is_from_me`, `is_bot_message` |
| `registered_groups` | `jid` (PK), `name`, `folder`, `trigger_pattern`, `added_at`, `container_config`, `requires_trigger`, `is_main`, `is_admin`, `multi_agent_router`, `container_channel` |
| `sessions` | `group_folder` (PK), `session_id` |
| `scheduled_tasks` | `id` (PK), `group_folder`, `chat_jid`, `prompt`, `description`, `schedule_type`, `schedule_value`, `context_mode`, `next_run`, `last_run`, `last_result`, `status`, `created_at`, `script` |
| `task_run_logs` | `id`, `task_id`, `run_at`, `duration_ms`, `status`, `result`, `error` |
| `delegations` | `uuid` (PK), `caller_jid`, `target_jid`, `created_at`, `expires_at`, `status` |
| `dashboard_chat_log` | `id` (PK), `chat_jid`, `sender`, `sender_name`, `content`, `timestamp`, `is_from_user` |
| `error_log` | `id`, `level`, `message`, `context`, `timestamp` |
| `router_state` | `key` (PK), `value` |

## Credential Rules

All secrets go in `~/.config/nanoclaw/secrets.env`. This includes:
- Model provider API keys (ANTHROPIC, OLLAMA, ZAI)
- Channel tokens (TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, DISCORD_BOT_TOKEN, etc.)
- Web search keys (*_WEB_SEARCH_API_KEY)
- Any other sensitive credentials

The `.env` file in the project root is for non-sensitive config only (e.g., `TZ=Europe/London`).

`readEnvFile()` in `src/env.ts` reads secrets.env first → .env second → process.env last.

**Never write secrets to `.env`.** Never reference `data/env/env` — it's dead code.

## Secrets / Credentials / Proxy

Containers never see real API keys or tokens. The credential proxy (`src/credential-proxy.ts`) runs on the host:

- Listens on `127.0.0.1:3001` (configurable via `CREDENTIAL_PROXY_PORT`)
- Containers send API requests to `http://host.docker.internal:3001` with a placeholder key
- Proxy swaps in real credentials from `~/.config/nanoclaw/secrets.env` (or `.env` fallback)
- `.env` in the project root is shadowed by `/dev/null` in main group containers

### Multi-Endpoint Routing

The proxy supports multiple upstream endpoints. Configure named vendors in `secrets.env`:

```
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...

OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_API_KEY=placeholder

ZAI_BASE_URL=https://api.z.ai/api/anthropic
ZAI_API_KEY=...
```

Each vendor is defined by a `{VENDOR}_BASE_URL` and `{VENDOR}_API_KEY` pair. The vendor name (lowercase) becomes the routing key. Optional per-vendor fields: `{VENDOR}_AUTH` (`x-api-key`/`bearer`/`sigv4`, default `x-api-key`) and `{VENDOR}_REGION` (required for `sigv4` and Bedrock SDK mode).

Groups select an endpoint via their preset (`containerConfig.preset` → resolved `endpoint` field). The proxy reads the `X-Nanoclaw-Endpoint` header on each request and routes to the matching vendor's upstream URL with its credentials.

## Per-Group Configuration (`containerConfig`)

Stored as JSON in the `registered_groups.container_config` PostgreSQL column. All fields are optional except `preset`.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `preset` | `string` | **required** | Named model preset from `~/.config/nanoclaw/model-presets.json`. Resolves endpoint, model, capabilities, contextWindow, compactThreshold, webSearchVendor |
| `taskPreset` | `string` | `undefined` (uses base preset) | Preset override for scheduled task runs |
| `nudgePreset` | `string` | `undefined` (uses base preset) | Preset override for nightly nudge runs |
| `skills` | `string[]` | `undefined` = all skills | Per-group skill selection. `[]` = none, `["x","y"]` = named only |
| `systemPrompt` | `string` | `undefined` | Appended after `claude_code` preset prompt (agent persona/instructions) |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers alongside built-in nanoclaw IPC. Key = server name, value = `{ command, args?, env? }` |
| `timeout` | `number` | `300000` (5 min) | Container timeout override in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories (validated against mount-allowlist.json) |
| `telegramBot` | `string` | `undefined` (default bot) | Telegram bot instance name. Maps to `TELEGRAM_{NAME}_BOT_TOKEN` in secrets.env |
| `injectionScanMode` | `'off' \| 'warn' \| 'block'` | `'warn'` | Prompt injection scanning for context files (CLAUDE.md, MEMORY.md, daily notes) before launch |
| `ssrfProtection` | `boolean \| SsrfConfig` | `true` (enabled) | SSRF protection for outbound web_fetch. `false` = disabled, `true` = default, object = custom host lists |
| `approvalMode` | `boolean` | `true` | Command approval for dangerous commands on write-mounted paths. Replaces Bash with `mcp__nanoclaw__execute_command` |
| `approvalTimeout` | `number` | `120` (2 min) | Seconds before an unanswered approval request auto-denies. Range: 10–600 |
| `commandAllowlist` | `string[]` | `[]` | Regex patterns for pre-approved commands that skip approval flow |
| `allowedHostCommands` | `string[]` | `undefined` = none | Per-group host command allowlist. `['model']` enables `/model` to switch presets |
| `learningLoop` | `boolean \| 'extract-only'` | `false` | Skill extraction during memory nudge. `true` = extract + load, `'extract-only'` = extract for review |
| `deniedTools` | `string[]` | `[]` | Per-group denied tools — subtracted from the system allowlist ceiling (tool-allowlist.json) |
| `hooks` | `string[]` | `undefined` | Ordered reminder keys (filenames in `docs/hooks/`) injected via UserPromptSubmit hook on live chat turns |

**Preset file schema** (`~/.config/nanoclaw/model-presets.json`):

```json
{
  "OK2.6": {
    "endpoint": "ollama",
    "model": "kimi-k2.6:cloud",
    "capabilities": { "vision": true, "thinking": true, "tools": true },
    "contextWindow": 262144,
    "compactThreshold": 0.57,
    "webSearchVendor": "ollama"
  }
}
```

| Preset Field | Type | Required | Default |
|--------------|------|----------|---------|
| `endpoint` | `string` | yes | — |
| `model` | `string` | yes | — |
| `capabilities` | `{ vision: boolean, thinking?: boolean, tools?: boolean }` | yes | — |
| `contextWindow` | `number` | no | `128000` |
| `compactThreshold` | `number` (0.1–0.95) | no | `0.8` |
| `webSearchVendor` | `string` | no | `"ollama"` |
| `transform` | `"openai"` \| absent | no | absent (passthrough) |
| `sdkMode` | `"anthropic"` \| `"bedrock"` \| absent | no | absent (`anthropic`) |

`transform: "openai"` activates bidirectional Anthropic Messages ↔ OpenAI ChatCompletions translation in the credential proxy. Required for open-source models on the Bedrock `bedrockoss` endpoint. See `repo/docs/credential-proxy-extensions.md` §"Amazon Bedrock via Mantle".

`sdkMode: "bedrock"` switches the container into Claude Code's native Bedrock mode (`CLAUDE_CODE_USE_BEDROCK=1`). The SDK emits Invoke API requests and decodes binary eventstream responses. No proxy transform needed — the proxy only injects auth. See `repo/docs/credential-proxy-extensions.md` §"Amazon Bedrock via the Invoke API (Direct) + Auth Modes".

> **Mantle proxy note**: For non-`anthropic` vendors, the proxy automatically strips `anthropic-beta` (SDK beta negotiation header) and `context_management` (SDK body field) — Mantle rejects these with 400; Ollama ignores them. Auto-compaction is unaffected (driven by `settings.json`).

**Auto-compaction**: At container spawn, `settings.json` is written with `autoCompactEnabled: true` and `autoCompactWindow = contextWindow * compactThreshold`. This tells the SDK to compact the conversation when input tokens exceed the threshold. Without this, non-Anthropic models (via Ollama) may never trigger compaction because the SDK cannot detect their context window from API responses.

**`agent-browser` binary mounting**: `agent-browser` is NOT installed in the Docker image. The binary is stored on the host at `container/binaries/agent-browser/` and mounted into the container only when `agent-browser` is explicitly in the group's `skills` list. `container/binaries/` MUST be committed to git — it is the only source of the binary at runtime.

**`allowedTools` complement**: The agent-runner computes `disallowedTools` as the complement of the resolved tool set at runtime. Resolution: `tool-allowlist.json` ceiling − `deniedTools` − conditional removals (Bash if approvalMode, WebSearch/WebFetch if !nativeWebTools). This blocks preset-injected CLI tools that bypass the SDK's `allowedTools` filter. You never configure `disallowedTools` directly — only `deniedTools` in `containerConfig`.

### Applying Group Config

Use the Management API to update nested fields:

```bash
# Set preset (preferred over the legacy `endpoint` field)
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"preset":"OK2.6"}' \
  http://localhost:3100/api/groups/tg:12345/preset

# View current config
curl -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3100/api/groups/tg:12345/config
```

> **Note**: The `endpoint` field is legacy — use `preset` for model selection.

### Model Configuration

Models are configured via presets defined in `~/.config/nanoclaw/model-presets.json`. Each group references a preset by name in `containerConfig.preset`.

**To switch presets at runtime**: Use `/model <preset>` (requires `allowedHostCommands: ['model']`). The container is recycled on switch.

**To set via API**:
```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"preset":"OK2.6"}' \
  http://localhost:3100/api/groups/tg:12345/preset
```

**`settings.json` is auto-generated** at container spawn from the resolved preset. Do not edit it manually — changes will be overwritten on next container start. It contains `ANTHROPIC_MODEL`, `autoCompactEnabled`, and `autoCompactWindow`.

## Session Architecture

Sessions persist across container restarts — agents are NOT stateless between messages.

1. First message → no session ID → SDK starts a fresh session, returns `newSessionId`
2. NanoClaw stores the ID in PostgreSQL (`sessions` table) via `setSession()`
3. Next message → stored `sessionId` passed to SDK → resumes from `.jsonl` transcript
4. Containers are NOT one-per-message: they stay alive (IPC polling), idle-timeout after 30 min, then next message spawns a new container that resumes the same session

Four memory layers:

| Layer | Survives Session Reset? | Purpose |
|-------|------------------------|---------|
| Session transcript (`.jsonl`) | No — tied to session ID | Full conversation continuity |
| `MEMORY.md` | Yes — persists across sessions | Durable facts, user preferences (5000 char cap) |
| `YYYY-MM-DD.md` | Yes — persists across sessions | Daily notes, observations, task progress |
| CLAUDE.md (group folder) | Yes — it's a file you control | Instructions, personality, skills |

## Context Loading Order

1. Claude Code built-in system prompt (`claude_code` preset)
2. `containerConfig.systemPrompt` (appended to preset prompt)
3. `CLAUDE.md` in the group folder (auto-loaded by SDK from `cwd`) — includes `@import` of `MEMORY.md`
4. `CLAUDE.md` in `additionalDirectories` (extra mounts, auto-loaded by SDK via `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`)
5. Session transcript (if resuming an existing session)

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/customize-claude-md` | Build or upgrade a group's CLAUDE.md from the modular prompt-behaviours snippet library |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Per-Group CLAUDE.md & Prompt Behaviours

Each group gets a `CLAUDE.md` that defines its personality, rules, and capabilities. Use `/customize-claude-md <folder>` to build or audit one.

**Snippet library**: `docs/prompt-behaviours/` contains modular behaviour snippets (gitignored — not pushed to GitHub). Files are named `{category}_{descriptor}.md` and designed to be concatenated:

- `core_` — universal behaviours (ack, question gate, memory, etc.)
- `comms_` — channel communication mechanics
- `scheduling_` — date/time awareness, task management
- `builder_` — code, git, deployment patterns

**Templates**: `docs/prompt-behaviours/template-group.md` (non-main) and `docs/prompt-behaviours/template-main.md` (main) serve as starting points. The `/customize-claude-md` skill layers snippets on top of these.

## Multi-Agent Routing

For configuring sub-agents and delegation, see:
- [agent-team-patterns.md](docs/claude-code/agent-team-patterns.md) — Conceptual patterns (Flow 1 vs Flow 2)
- [delegation-setup.md](docs/delegation-setup.md) — Setup, SQL commands, troubleshooting

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

### Test Database

Tests require the `nanoclaw_test` database in the local PG container.

**Fresh setup** (empty volume): Handled automatically — `docker-compose.yml` mounts `scripts/init-test-db.sql` into PG's init directory.

**Existing volume** (init scripts don't re-fire): Create manually:
```bash
docker compose exec postgres psql -U nanoclaw -c "CREATE DATABASE nanoclaw_test OWNER nanoclaw"
```

**Verify it exists:**
```bash
docker compose exec postgres psql -U nanoclaw -lqt | grep nanoclaw_test
```

If the database already exists, the `CREATE DATABASE` command will error harmlessly ("already exists"). Then run tests:
```bash
npx vitest --run
```

### When to rebuild what

NanoClaw has two build targets — the host process and the container image. They are independent.

| What changed | Action needed |
|-------------|---------------|
| `src/` (host code) | `npm run build` + restart service |
| `container/agent-runner/` (code that runs inside containers) | `./container/build.sh` |
| `container/skills/` (skills loaded into containers) | `./container/build.sh` |
| `container/Dockerfile` | `./container/build.sh` |
| Both `src/` and `container/` | `npm run build` + `./container/build.sh` + restart service |

If you only change host code (`src/`), you do NOT need to rebuild the container image. If you only change container code, you do NOT need to restart the service (new containers will use the new image). If you change both, do both.

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

**How it works now:** Source files are copied dynamically on every container start:
- `container/agent-runner/src/` → `data/sessions/{group}/agent-runner-src/` → mounted as `/app/src`
- `container/skills/` → `data/sessions/{group}/.claude/skills/` → synced to container

Changes to TypeScript source or skills appear automatically on the next container run. No manual cache clearing needed for source changes.

**When you need to rebuild the Docker image:**
- Changes to `container/Dockerfile`
- Changes to `container/agent-runner/package.json` (dependencies)
- Changes to `container/agent-runner/dist/` (pre-compiled JS)

```bash
# Rebuild container image
rm -rf container/agent-runner/dist   # Clear local dist (BuildKit may cache it)
docker builder prune -f              # Prune BuildKit cache
./container/build.sh                 # Rebuild
docker ps --filter ancestor=nanoclaw-agent:stable -q | xargs -r docker kill  # Stop old containers
```

**If agent reports outdated tools after image rebuild**, the session transcript may have cached tool definitions. Clear it:
```bash
rm data/sessions/<group>/.claude/projects/-workspace-group/*.jsonl
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/sessions/<group>
```

**"No conversation found with session ID" error**: The database has a session ID but the JSONL transcript is missing. This happens if you delete files without deleting the database row. Fix by clearing the session row (see "To clear chat history for a group" below).

**To clear chat history for a group** (fresh start, no conversation memory):

The Management API clears both the DB row and the in-memory session cache — no restart needed:

```bash
# 1. Delete session row (and in-memory cache)
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/sessions/<folder>

# 2. Verify deletion
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/sessions/<folder>
# Expected: 404 (no session for that folder)
```

That's it. The JSONL file can remain — without a session row, the SDK starts a fresh session on the next message.

**Optional additional cleanup:**
```bash
# Delete message history from database (incoming + outgoing)
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" "http://localhost:3100/api/chats/<jid>/messages?confirm=true"

# Diagnostic only (API returns messages, not counts):
docker compose exec postgres psql -U nanoclaw nanoclaw -c "SELECT COUNT(*) FROM messages WHERE chat_jid='<jid>'"
# Expected: "0"

# Clear auto-memory
rm -f data/sessions/<folder>/.claude/projects/-workspace-group/memory/*.md

# Remove orphaned JSONL files (optional cleanup, not required)
rm -f data/sessions/<folder>/.claude/projects/-workspace-group/*.jsonl
```

**Why restart is required:** The `sessions` object in `src/index.ts` caches session IDs in memory. Deleting from the database only clears persistence — the next message recreates the row from memory. Restart reloads from the now-empty database.

## Memory

Store persistent context here (not in `~/.claude/projects/` auto-memory). This file travels with the repo.

### User Preferences

- User types answers directly in chat rather than using AskUserQuestion option buttons. For free-text values (usernames, tokens, IDs), just ask in chat text instead of using AskUserQuestion.

### Project State

- **Provider**: Ollama at `http://localhost:11434` (Anthropic-compatible API)
- **Model**: Resolved from `containerConfig.preset` via `model-presets.json` (e.g. `OK2.6` → `kimi-k2.6:cloud`)
- **Credentials**: Native credential proxy — reads vendor keys from `~/.config/nanoclaw/secrets.env`
- **Channel**: Telegram bot `@dandysandy_bot` (token in `secrets.env`)
- **Registered chat**: `tg:123456789` (GM's DM), folder `telegram_main`, no trigger required (main group)
- **Group containerConfig**: `allowedTools` excludes `WebSearch` and `WebFetch`
- **Sender allowlist**: `~/.config/nanoclaw/sender-allowlist.json` — only user ID `123456789` allowed
- **Mount allowlist**: empty (isolated), at `~/.config/nanoclaw/mount-allowlist.json`
- **Fork**: `https://github.com/gmacgmac/nanoclaw.git` (origin), upstream `https://github.com/qwibitai/nanoclaw.git`
- **Skills merged**: `skill/native-credential-proxy`, `telegram/main`
- **Service**: launchd on macOS (`com.nanoclaw`)

### References

<!-- Pointers to external resources, dashboards, documentation -->

<!-- END MEMORY -->

---

## Container Image Versioning

All container image work goes through `container/scripts/container.sh`. Do not use `docker build` directly.

Source of truth: [`container/VERSIONING.md`](container/VERSIONING.md)

### Three Rules

1. **Never run `docker build` directly on the agent image.** Always use `container/scripts/container.sh build <version>`.
2. **Never re-tag `:stable` without explicit user confirmation.** Promotion is a manual decision point.
3. **Always update `container/VERSIONS.json` through the script**, never by hand-editing.

### Channel System

| Channel | Purpose |
|---------|---------|
| `:stable` | Default. All groups use this unless explicitly switched. |
| `:next` | Canary. Test new SDK/CLI versions on select groups before promotion. |

Versioned tags (e.g. `v1.0.0`) are immutable — never overwritten. `:stable` and `:next` are mutable aliases managed by the script.

There is no `:latest` tag. `build.sh` rejects no-arg invocations.

### Host-Side Integration

The host-side TypeScript code reads each group's channel from the `container_channel` column on `registered_groups` (default: `'stable'`). At container spawn, the channel is resolved to an image tag via `container/VERSIONS.json`. See `src/container-runner.ts` for the resolution logic.

