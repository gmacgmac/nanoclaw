# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

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

OLLAMA_BASE_URL=http://localhost:11434/v1
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
| `endpoint` | `string` | `"anthropic"` | Named vendor from `secrets.env` (e.g. `"ollama"`, `"zai"`). Routes API traffic to that upstream |
| `skills` | `string[]` | `undefined` = all | Per-group skill selection. `[]` = none, `["x"]` = named only |
| `globalAccess` | `object` | `undefined` = full read-only | Global dir mount control. `{}` = no access, `{ "*": { readonly: true } }` = all |
| `allowedTools` | `string[]` | `undefined` = default list | Per-group tool restrictions. `mcp__nanoclaw__*` always included |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers alongside built-in nanoclaw IPC |
| `model` | `string` | `undefined` = inherit | Per-group model override (e.g. `"sonnet"`, `"haiku"`). Prefer `settings.json` for easier editing |
| `systemPrompt` | `string` | `undefined` = global CLAUDE.md | Appended after `claude_code` preset + global CLAUDE.md |
| `timeout` | `number` | `300000` (5 min) | Container timeout override in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories (validated against mount-allowlist.json) |

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

Three memory layers:

| Layer | Survives Session Reset? | Purpose |
|-------|------------------------|---------|
| Session transcript (`.jsonl`) | No | Full conversation continuity |
| Auto-memory (`memory/*.md`) | Yes | Learned preferences, corrections |
| CLAUDE.md (group folder) | Yes | Instructions, personality, skills |

## Context Loading Order

| Group type | What's loaded |
|------------|---------------|
| Main (`is_main=1`) | preset + `groups/{folder}/CLAUDE.md` |
| Non-main | preset + `global/CLAUDE.md` + `groups/{folder}/CLAUDE.md` |

Note: `main/CLAUDE.md` is a template (not auto-loaded). `global/CLAUDE.md` is appended for non-main groups only.

After group CLAUDE.md:
1. `containerConfig.systemPrompt` (if set)
2. Auto-memory files (`memory/*.md`)
3. Session transcript (if resuming)

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
- [AGENT_TEAM_PATTERNS.md](docs/AGENT_TEAM_PATTERNS.md) — Conceptual patterns (Flow 1 vs Flow 2)
- [DELEGATION_SETUP.md](docs/DELEGATION_SETUP.md) — Setup, SQL commands, troubleshooting

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

**Root cause**: Containers run from a *cached copy* of the agent-runner source at `data/sessions/*/agent-runner-src/`, not from `container/agent-runner/src/` directly. Changes to the source won't appear until this cache is cleared. This is the most common reason MCP tool changes or SDK updates don't take effect. (Tracked: issue #1236; PR #1515 may introduce `.mcp.json` per-group config as a cleaner path for MCP changes.)

Multiple caching layers can prevent container code changes from appearing. The complete fix:

```bash
# 1. CRITICAL: Delete cached agent-runner source (most common issue)
rm -rf data/sessions/*/agent-runner-src

# 2. Delete local dist/ (BuildKit caches this)
rm -rf container/agent-runner/dist

# 3. Prune BuildKit cache
docker builder prune -f

# 4. Rebuild from correct directory
./container/build.sh

# 5. Kill running containers
docker ps --filter ancestor=nanoclaw-agent:latest -q | xargs -r docker kill
```

**When you need a clean rebuild**:
- TypeScript changes in `container/agent-runner/src/` aren't appearing
- New MCP tools or skills not loading
- Agent reports outdated tool definitions
- Image ID unchanged after rebuild

**After MCP tool changes**, also update `container/skills/*/SKILL.md` to match actual tools (synced at container start).

**If agent still reports old tools**, clear the session transcript:
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
- **Credentials**: Native credential proxy — reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from `.env`
- **Channel**: Telegram bot `@dandysandy_bot` (token in `.env`)
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
