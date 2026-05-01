# NanoClaw

Personal Claude assistant. See [README.md](README.md) for setup, architecture, and security configuration. See [docs/requirements.md](docs/requirements.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in isolated Docker containers. Each group has its own filesystem, session state, and memory. Credentials never reach containers — a host-side proxy injects them at request time. Per-group behaviour is controlled via `containerConfig` stored in SQLite.

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
| `src/db.ts` | SQLite operations (messages, groups, sessions, tasks, errors) |
| `src/credential-proxy.ts` | Host-side API proxy — injects real credentials into container requests |
| `src/group-queue.ts` | Per-group FIFO queue with global concurrency limit |
| `src/mount-security.ts` | Mount allowlist validation for container volumes |
| `src/env.ts` | Environment variable loading from secrets.env and .env |
| `src/logger.ts` | Built-in logger with DB error wrapper |
| `src/types.ts` | TypeScript interfaces (ContainerConfig, Channel, RegisteredGroup) |
| `store/messages.db` | SQLite database (registered_groups, messages, sessions tables) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers |
| `container/agent-runner/src/index.ts` | Agent entry point inside containers (SDK invocation) |

## Host-Side Development (This Chat)

When working in Claude Code CLI on the host (this context), write memories to this CLAUDE.md file, not to `~/.claude/projects/` auto-memory. The auto-memory system is machine-specific and not portable. Group chats use their own memory system inside containers (`groups/{name}/CLAUDE.md` + `data/sessions/{group}/memory/`).

Query the database with: `sqlite3 store/messages.db`

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

ZAI_BASE_URL=https://api.z.ai
ZAI_API_KEY=...
```

Each vendor is defined by a `{VENDOR}_BASE_URL` and `{VENDOR}_API_KEY` pair. The vendor name (lowercase) becomes the routing key.

Groups select an endpoint via `containerConfig.endpoint` (defaults to `"anthropic"`). The proxy reads the `X-Nanoclaw-Endpoint` header on each request and routes to the matching vendor's upstream URL with its credentials.

## Per-Group Configuration (`containerConfig`)

Stored as JSON in the `registered_groups.container_config` SQLite column. All fields are optional.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `endpoint` | `string` | **required** | Named vendor from `secrets.env` (e.g. `"ollama"`, `"zai"`). Routes API traffic to that upstream |
| `skills` | `string[]` | `undefined` = all | Per-group skill selection. `[]` = none, `["x"]` = named only |
| `allowedTools` | `string[]` | `undefined` = default list | Per-group tool restrictions. `mcp__nanoclaw__*` always included |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers alongside built-in nanoclaw IPC |
| `model` | `string` | `undefined` = inherit | Per-group model override (e.g. `"sonnet"`, `"haiku"`). Prefer `settings.json` for easier editing |
| `systemPrompt` | `string` | `undefined` | Appended after `claude_code` preset prompt |
| `timeout` | `number` | `300000` (5 min) | Container timeout override in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories (validated against mount-allowlist.json) |
| `contextWindowSize` | `number` | `128000` | Token threshold for auto-flush (80% live, 50% nightly) |
| `webSearchVendor` | `string` | `undefined` | Routes web search through named vendor's proxy endpoint |
| `allowedHostCommands` | `string[]` | `undefined` = none | Per-group host command allowlist. `['model']` enables `/model` to switch presets |

**`agent-browser` binary mounting**: `agent-browser` is NOT installed in the Docker image. The binary is stored on the host at `container/binaries/agent-browser/` and mounted into the container only when `agent-browser` is in the group's `skills` list (or `skills` is undefined). `container/binaries/` MUST be committed to git — it is the only source of the binary at runtime.

**`allowedTools` complement**: The agent-runner computes `disallowedTools` as the complement of `allowedTools` at runtime. This blocks preset-injected CLI tools that bypass the SDK's `allowedTools` filter. You never configure `disallowedTools` directly.

### Applying Group Config

Use `json_set()` to update nested fields:

```bash
# Set endpoint
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.endpoint', 'ollama') WHERE folder = 'mygroup'"

# View current config
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = 'mygroup'"
```

### Model Configuration

Two ways to set per-group models:

**Preferred: `settings.json`** (easier to edit)
```bash
# File: data/sessions/{folder}/.claude/settings.json
{
  "ANTHROPIC_MODEL": "claude-sonnet-4-6"
}
```

**Alternative: database** (overrides everything)
```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.model', 'sonnet') WHERE folder = 'mygroup'"
```

To switch from database to settings.json (recommended), remove the model from the database:
```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_remove(container_config, '$.model') WHERE folder = 'mygroup'"
```

The model precedence:
1. `container_config.model` (database) — overrides everything
2. `data/sessions/{folder}/.claude/settings.json` → `ANTHROPIC_MODEL` — group-specific model
3. `.env` → `ANTHROPIC_MODEL` — global default
4. SDK default

**Endpoint** must be in database (no settings.json fallback):
```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.endpoint', 'zai') WHERE folder = 'mygroup'"
```

## Session Architecture

Sessions persist across container restarts — agents are NOT stateless between messages.

1. First message → no session ID → SDK starts a fresh session, returns `newSessionId`
2. NanoClaw stores the ID in SQLite (`sessions` table) via `setSession()`
3. Next message → stored `sessionId` passed to SDK → resumes from `.jsonl` transcript
4. Containers are NOT one-per-message: they stay alive (IPC polling), idle-timeout after 30 min, then next message spawns a new container that resumes the same session

Four memory layers:

| Layer | Survives Session Reset? | Purpose |
|-------|------------------------|---------|
| Session transcript (`.jsonl`) | No — tied to session ID | Full conversation continuity |
| `MEMORY.md` | Yes — persists across sessions | Durable facts, user preferences |
| `COMPACT.md` | Yes — overwritten on each flush | Session summary after compaction |
| CLAUDE.md (group folder) | Yes — it's a file you control | Instructions, personality, skills |

## Context Loading Order

1. Claude Code built-in system prompt (`claude_code` preset)
2. `containerConfig.systemPrompt` (appended to preset prompt)
3. `CLAUDE.md` in the group folder (auto-loaded by SDK from `cwd`) — includes `@import` of `MEMORY.md` and `COMPACT.md`
4. Session transcript (if resuming an existing session)

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
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Multi-Agent Routing

For configuring sub-agents and delegation, see:
- [agent-team-patterns.md](docs/agent-team-patterns.md) — Conceptual patterns (Flow 1 vs Flow 2)
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
docker ps --filter ancestor=nanoclaw-agent:latest -q | xargs -r docker kill  # Stop old containers
```

**If agent reports outdated tools after image rebuild**, the session transcript may have cached tool definitions. Clear it:
```bash
rm data/sessions/<group>/.claude/projects/-workspace-group/*.jsonl
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='<group>'"
```

**"No conversation found with session ID" error**: The database has a session ID but the JSONL transcript is missing. This happens if you delete files without deleting the database row. Fix by clearing the session row and restarting (see "To clear chat history for a group" below).

**To clear chat history for a group** (fresh start, no conversation memory):

**CRITICAL:**
1. Run DELETE and VERIFY in a single chained command with `&&` — sqlite3 commands in separate shell invocations may not commit properly.
2. Restart is REQUIRED — NanoClaw holds session IDs in memory (`src/index.ts:357`). The database delete will be undone if you don't restart.

```bash
# 1. Delete session row from database (MUST chain with VERIFY)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='<folder>'" && sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder='<folder>'"
# Expected: no output (empty result means DELETE succeeded)

# 2. Restart service (REQUIRED — clears in-memory session cache)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

That's it. The JSONL file can remain — without a session row, the SDK starts a fresh session on the next message.

**Optional additional cleanup:**
```bash
# Delete message history from database (incoming + outgoing)
sqlite3 store/messages.db "DELETE FROM messages WHERE chat_jid='<jid>'" && sqlite3 store/messages.db "SELECT COUNT(*) FROM messages WHERE chat_jid='<jid>'"
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
- **Model**: `glm-5:cloud` (set via `ANTHROPIC_MODEL` in `.env` and `data/sessions/{group}/.claude/settings.json`)
- **Credentials**: Native credential proxy — reads vendor keys from `~/.config/nanoclaw/secrets.env`
- **Channel**: Telegram bot `@dandysandy_bot` (token in `secrets.env`)
- **Registered chat**: `tg:6013943815` (GM's DM), folder `telegram_main`, no trigger required (main group)
- **Group containerConfig**: `allowedTools` excludes `WebSearch` and `WebFetch`
- **Sender allowlist**: `~/.config/nanoclaw/sender-allowlist.json` — only user ID `6013943815` allowed
- **Mount allowlist**: empty (isolated), at `~/.config/nanoclaw/mount-allowlist.json`
- **Fork**: `https://github.com/gmacgmac/nanoclaw.git` (origin), upstream `https://github.com/qwibitai/nanoclaw.git`
- **Skills merged**: `skill/native-credential-proxy`, `telegram/main`
- **Service**: launchd on macOS (`com.nanoclaw`)

### References

<!-- Pointers to external resources, dashboards, documentation -->

<!-- END MEMORY -->
