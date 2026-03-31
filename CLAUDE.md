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
- Two auth modes: **API key** (injects `x-api-key` on every request) or **OAuth** (replaces Bearer token on exchange requests)
- `.env` in the project root is shadowed by `/dev/null` in main group containers

## Per-Group Configuration (`containerConfig`)

Stored as JSON in the `registered_groups.container_config` SQLite column. All fields are optional.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `skills` | `string[]` | `undefined` = all | Per-group skill selection. `[]` = none, `["x"]` = named only |
| `globalAccess` | `object` | `undefined` = full read-only | Global dir mount control. `{}` = no access, `{ "*": { readonly: true } }` = all |
| `allowedTools` | `string[]` | `undefined` = default list | Per-group tool restrictions. `mcp__nanoclaw__*` always included |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers alongside built-in nanoclaw IPC |
| `model` | `string` | `undefined` = inherit | Per-group model override (e.g. `"sonnet"`, `"haiku"`) |
| `systemPrompt` | `string` | `undefined` = global CLAUDE.md | Appended after `claude_code` preset + global CLAUDE.md |
| `timeout` | `number` | `300000` (5 min) | Container timeout override in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories (validated against mount-allowlist.json) |

**`agent-browser` binary mounting**: `agent-browser` is NOT installed in the Docker image. The binary is stored on the host at `container/binaries/agent-browser/` and mounted into the container only when `agent-browser` is in the group's `skills` list (or `skills` is undefined). `container/binaries/` MUST be committed to git — it is the only source of the binary at runtime.

**`allowedTools` complement**: The agent-runner computes `disallowedTools` as the complement of `allowedTools` at runtime. This blocks preset-injected CLI tools that bypass the SDK's `allowedTools` filter. You never configure `disallowedTools` directly.

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

1. Claude Code built-in system prompt (`claude_code` preset)
2. `global/CLAUDE.md` content (non-main groups only, if file exists)
3. `containerConfig.systemPrompt` (if set)
4. Group `CLAUDE.md` (auto-loaded by SDK from `cwd` = `/workspace/group`)
5. Auto-memory files (`memory/*.md`)
6. Session transcript (if resuming an existing session)

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
sqlite3 store/messages.db "UPDATE sessions SET session_id=NULL WHERE group_folder='<group>'"
```

For detailed explanation, see [agentic-tools/nanoclaw/CONTAINER_CACHE_ISSUE.md](agentic-tools/nanoclaw/CONTAINER_CACHE_ISSUE.md).

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
