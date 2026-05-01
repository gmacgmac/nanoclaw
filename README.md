> **Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).**
> This is a heavily customized personal installation with multi-endpoint support,
> per-group security policies, web search proxy, and advanced context management.
> For the original minimal version, see upstream.

---
category: agentic-tools
scope: nanoclaw
last_updated: 2026-04-15
status: active
keywords: nanoclaw, agent, telegram, dashboard, claude-agent-sdk, sessions, memory, isolation, containerConfig, credential-proxy, multi-endpoint, context-management, flush, delegation, web-search
---

# NanoClaw

> Throughout this document, `$NANOCLAW_ROOT` refers to the NanoClaw repo root directory. This is typically `~/.nanoclaw/` but may vary by machine (e.g. `~/.nanoclaw/repo/`).

NanoClaw is the always-on personal AI agent system. It runs as a Node.js orchestrator (~6,200 lines) that listens on messaging channels, routes messages to isolated Docker containers, and manages persistent sessions via the Claude Agent SDK.

---

## How It Works

```
Message In (Telegram / Dashboard)
    ↓
SQLite (store message, deduplicate)
    ↓
Group Queue (per-group FIFO, one container at a time)
    ↓
Container (Claude Agent SDK query() with session resumption)
    ↓
Response → Channel Out (Telegram API / Dashboard DB poll)
```

Each group gets an isolated Docker container with its own filesystem, session state, IPC namespace, and skills. Containers are ephemeral but sessions persist — the agent resumes full conversational context across container restarts.

---

## Session Architecture (Critical)

This is the most important thing to understand about NanoClaw. Agents are NOT stateless between messages.

### How Sessions Work

1. First message to a group → no session ID → Claude Agent SDK starts a fresh session
2. The SDK returns a `newSessionId` (a UUID like `16532bac-737e-4fc4-805f-b7ce971b87d9`)
3. NanoClaw stores this ID in SQLite (`sessions` table) via `setSession()`
4. Next message → NanoClaw passes the stored `sessionId` → SDK resumes from the `.jsonl` transcript
5. This continues indefinitely — every message resumes the same session with full conversation history

### Where Session Data Lives

| What | Host Path | Purpose |
|------|-----------|---------|
| Session transcript | `data/sessions/<folder>/.claude/projects/-workspace-group/<uuid>.jsonl` | Full conversation history (Claude Code internal format) |
| Auto-memory | `data/sessions/<folder>/.claude/projects/-workspace-group/memory/*.md` | Persistent notes Claude writes itself (survives session reset) |
| Session ID mapping | `store/messages.db` → `sessions` table | Maps group folder → current session UUID |
| Settings | `data/sessions/<folder>/.claude/settings.json` | Claude Code env vars (model, features) |
| Skills | `data/sessions/<folder>/.claude/skills/` | Copied from `container/skills/` per-group |

### Four Layers of Memory

| Layer | Mechanism | Survives Session Reset? | Primary Use |
|-------|-----------|------------------------|-------------|
| Session transcript (`.jsonl`) | SDK session resumption | No — tied to session ID | Full conversation continuity |
| `MEMORY.md` | `@import` in CLAUDE.md → SDK loads at spawn | Yes — persists across sessions | Durable facts, user preferences |
| `COMPACT.md` | `@import` in CLAUDE.md → SDK loads at spawn | Yes — overwritten on each flush | Session summary after compaction |
| CLAUDE.md (group folder) | SDK loads from `cwd` on startup | Yes — it's a file you control | Instructions, personality, skills |

The session transcript is the primary memory mechanism — the agent gets full conversation replay on every message. `MEMORY.md` and `COMPACT.md` are loaded via `@import` directives in CLAUDE.md templates, so they're always available even after a session reset. CLAUDE.md is for explicit instructions you want the agent to always follow.

When a flush triggers (auto, manual, or nightly), the agent writes durable facts to `MEMORY.md` and a compact summary to `COMPACT.md`. The host then deletes the session so the next message starts fresh — but the `@import`ed files preserve essential context.

### Container Lifecycle

Containers are NOT one-per-message. The flow is:

1. Message arrives → container spawns (or message is piped to existing container via IPC)
2. Container stays alive, waiting for follow-up messages via IPC polling
3. After 30 minutes of no output (idle timeout), NanoClaw stops the container
4. Next message → new container spawns, but resumes the same session via `sessionId`

The `--rm` flag on `docker run` ensures containers are cleaned up after exit.

---

## Context Management

Agents accumulate context over long conversations. Without intervention, they eventually hit the model's context window limit and degrade in quality. NanoClaw solves this with automatic memory flushing and session recycling.

### How Flushing Works

When triggered (automatically or manually), the agent runs a structured **flush prompt** (`buildFlushPrompt()` in `src/lib/flush-prompt.ts`) that instructs it to:

1. **Extract skills** (conditional) → `extracted-skills/[skill-name].md` — only when `containerConfig.learningLoop` is truthy. Cap of 2 skills per flush. See [Learning Loop](#learning-loop--skill-extraction).
2. **Append durable facts** to `memory/MEMORY.md` — user preferences, corrections, long-term knowledge
3. **Write a session summary** to `memory/COMPACT.md` — overwrite (not append), ~2000 word cap, key decisions and open items
4. **Append a daily note** to `memory/YYYY-MM-DD.md` — contextual observations from this session

Skill extraction runs first because it needs the full uncompacted conversation context. The remaining steps are unchanged from the original flush flow.

Both `getFlushPrompt()` (agent-runner, context-window trigger) and `getNightlyFlushPrompt()` (host-side, nightly cron) delegate to `buildFlushPrompt()` — a single source of truth. A copy exists at `container/agent-runner/src/lib/flush-prompt.ts` (container boundary — cannot import from host `src/` at runtime).

After the flush completes:

- The agent emits `flushCompleted: true` to the host
- The host deletes the session from SQLite and clears its in-memory cache
- The next message starts a fresh session — but `MEMORY.md` and `COMPACT.md` are loaded via `@import` in CLAUDE.md, so the agent retains key context

Status messages appear during flush: "Creating long term memories..." before, "Ready for next message" after. These are visible to the user.

### Three Flush Triggers

| Trigger | Threshold | When | How It Fires |
|---------|-----------|------|-------------|
| **Auto-flush** | 80% of `contextWindowSize` | Live, mid-conversation | Agent-runner detects `input_tokens` from SDK usage data |
| **Manual flush** | Any time | On demand | Agent calls `manual_flush` MCP tool (writes `_flush` sentinel to IPC) |
| **Nightly cron** | 50% of `contextWindowSize` | Midnight (configurable) | `runNightlyMaintenance()` checks all groups with active sessions |

All three use the same flush prompt and `flushCompleted` → session reset flow. A `flushedThisSession` guard prevents double-flush within a single container run.

### `contextWindowSize` — Per-Group Context Limit

Controls when flushes trigger. Set in `containerConfig`:

```json
{ "contextWindowSize": 128000 }
```

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Default: 128000 tokens |
| `64000` | Smaller model — flush sooner |
| `200000` | Larger context model — flush later |

To set per-group:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.contextWindowSize', 200000) WHERE folder = 'mygroup'"
```

### Token Usage Logging

The agent-runner logs `input_tokens` and `output_tokens` from every SDK response to `groups/{folder}/token-usage.log`. This file drives the nightly cron's threshold calculation (`parseLastInputTokens()`).

Log format:

```
[2026-04-07T21:30:00.000Z] id=msg_01ABC type=text input=42000 output=1200
```

Entries are deduplicated by message ID (last-write-wins). The file is append-only and grows indefinitely — prune manually if needed.

### Nightly Maintenance

A built-in cron job (`startNightlyCron` in `src/task-scheduler.ts`) runs at midnight by default. It is **not** a row in the `scheduled_tasks` table — it is a separate subsystem that runs alongside the user-facing task scheduler.

For each registered group with an active session:

1. Reads `input_tokens` from `token-usage.log` (via `parseLastInputTokens()`)
2. Computes usage ratio: `input_tokens / contextWindowSize`
3. If >= 50%, runs the flush prompt, then clears the session

Groups below 50% or without active sessions are skipped. Results are logged: `{ groupsChecked, groupsFlushed }`.

---

## Daily Use

Message your Telegram bot. Default trigger word is `@Andy`.

```
@Andy hello, what can you see in the workspace?
@Andy search the web for "latest AI news"
@Andy remember this: I prefer concise responses in British English
@Andy what did I ask you to remember?
@Andy every weekday at 8am, send me the top 3 Hacker News stories
```

NanoClaw runs agents in isolated Docker containers. Each group (personal, research, coding) has its own memory and context.

---

## Configuring NanoClaw (via Claude Code)

Open Claude Code pointed at the NanoClaw repo:

```bash
cd $NANOCLAW_ROOT && claude
```

Then describe changes in plain English or use slash commands (`/add-telegram`, `/debug`, `/status`).

Claude Code is the wrench. NanoClaw is the engine.

---

## Memory and Context

### CLAUDE.md

Each group has a `CLAUDE.md` file at `groups/<group>/CLAUDE.md`. The Claude Agent SDK auto-loads this from the working directory (`/workspace/group`) at session start.

- "Remember this: ..." → agent may write to `MEMORY.md` or `CLAUDE.md`
- You can edit CLAUDE.md directly — it's plain markdown
- CLAUDE.md templates include `@import` directives for `@memory/MEMORY.md` and `@memory/COMPACT.md`, which the SDK expands at container spawn time

### Memory Protocol

Agents manage three memory files inside `groups/{folder}/memory/`:

| File | Behaviour | Purpose |
|------|-----------|---------|
| `MEMORY.md` | Read, append, remove superseded entries. No duplicates. | Durable facts — user preferences, corrections, long-term knowledge |
| `COMPACT.md` | Overwrite on flush (~2000 word cap). | Session summary — key decisions and open items after compaction |
| `YYYY-MM-DD.md` | Append daily. | Session-specific observations and daily notes |

The `memory/` directory is created automatically during group registration, along with a seed `MEMORY.md` if one doesn't exist.

### How Context Loads (in order)

1. Claude Code built-in system prompt (`claude_code` preset)
2. `containerConfig.systemPrompt` (appended to preset prompt)
3. `CLAUDE.md` in the group folder (auto-loaded by SDK from `cwd`) — includes `@import` of `MEMORY.md` and `COMPACT.md`
4. Session transcript (if resuming an existing session)

---

## Agent Response Delivery

Understanding how agent output reaches the user is critical for writing correct CLAUDE.md instructions and skills.

### Two Independent Delivery Paths

Every agent run has two separate mechanisms that both deliver text to the channel:

| Path | Source | When it fires |
|------|--------|---------------|
| Text output | `result.result` from the container | When the agent finishes (or per streaming result) |
| `send_message` | `mcp__nanoclaw__send_message` MCP tool | Immediately, mid-run, when the agent calls it |

Both paths call `channel.sendMessage()` independently. If an agent calls `send_message` AND produces text output, the user receives two separate messages. This is a common source of duplicate/unwanted messages.

### Correct Use of `send_message`

`send_message` is for:
- Sending an acknowledgement before a long task ("On it, give me a moment")
- Delegating to another group via `target_jid`

For normal replies, the agent should just respond with text. That text is the delivery. Do not use `send_message` as the primary reply mechanism.

This must be explicitly stated in each group's `CLAUDE.md` — agents default to using `send_message` for everything if not instructed otherwise.

### Suppressing Unwanted Output with `<internal>` Tags

`formatOutbound()` in `src/router.ts` strips `<internal>...</internal>` blocks before sending text output to the channel. Agents can use this to suppress post-tool commentary that should not reach the user:

```
<internal>Message sent, waiting for next input.</internal>
```

Include this pattern in CLAUDE.md for any group where the agent tends to narrate its own actions after tool calls.

### Channel-Specific Formatting

Each channel has different markdown support. Agents must know which syntax to use or output will render incorrectly. The mechanism is a formatting skill loaded per-group via `containerConfig.skills`.

Always include the relevant formatting skill for the channel type:

| Channel | Skill | Key difference |
|---------|-------|----------------|
| Telegram | `telegram-formatting` | Markdown v1 only — `*bold*`, no `**double**`, no `# headings` |
| Slack | `slack-formatting` | mrkdwn — `*bold*`, `<url\|text>` links |
| Discord | (standard markdown) | Full markdown supported |

Do not duplicate formatting rules in CLAUDE.md — point to the skill instead. Duplication causes drift.

---

## Multi-Agent Delegation

Agents can delegate tasks to other registered groups and receive responses back. This enables orchestration patterns where a hub agent dispatches work to specialized sub-agents.

### MCP Tools

| Tool | Who Can Use | Purpose |
|------|-------------|---------|
| `delegate_to_group` | Main group only | Send a task to a target group, get a UUID for correlation |
| `respond_to_group` | Any group | Respond to a pending delegation (validates UUID, caller identity) |
| `manual_flush` | Any group | Trigger a memory flush mid-session (see [Context Management](#context-management)) |

**`delegate_to_group`** parameters:
- `target_jid` — the JID of the target group (e.g. `tg:12345@internal`)
- `prompt` — the task description
- `ttl_seconds` — delegation expiry (30–3600, default 300)

The host stores the delegation in the `delegations` table with a UUID, injects the prompt as a user message into the target group, and wakes the target agent. The target agent's response flows back via `respond_to_group`.

**`respond_to_group`** parameters:
- `uuid` — the delegation UUID
- `response_text` — the response content

The host validates the UUID (exists, not expired, not already fulfilled, caller is the correct target). If valid, it marks the delegation fulfilled and stores the response in the caller's message queue, waking the caller agent.

### `multiAgentRouter` — Hub Group Routing

A `multi_agent_router` flag on `RegisteredGroup` enables a hub group to intercept messages addressed to sub-agents via their trigger patterns.

| `requiresTrigger` | `multiAgentRouter` | Behaviour |
|-------------------|-------------------|-----------|
| `true` | `false` | Standard: only responds to own trigger |
| `false` | `false` | Chatty: responds to everything |
| `false` | `true` | Hub: responds to non-trigger messages, intercepts other agents' triggers and routes to sub-agent |

When a hub group has `multiAgentRouter: true`, the host scans incoming messages for other registered groups' trigger patterns. Matched messages are auto-routed to the sub-agent. Unmatched `@` patterns get an "agent unavailable" notification. Non-trigger messages go to the hub agent normally.

Sub-agents respond via `send_message` to the hub's JID (the user sees the response in the same chat).

```bash
# Enable hub routing
sqlite3 store/messages.db "UPDATE registered_groups SET multi_agent_router = 1 WHERE folder = 'myhub'"
```

---

## Data Storage

### SQLite Database (`store/messages.db`)

The database serves the application layer — message routing, group registration, scheduling, and the dashboard UI.

| Table | Purpose |
|-------|---------|
| `messages` | Inbound user messages (input queue for the message loop) + bot responses for dashboard-channel conversations |
| `chats` | Chat metadata (JID, name, last activity, channel) |
| `sessions` | Maps group folder → current Claude session UUID |
| `registered_groups` | Group config (name, folder, trigger, containerConfig, `multi_agent_router`) |
| `delegations` | Inter-group task delegations (UUID, caller, target, status, expiry) |
| `scheduled_tasks` | Cron/interval tasks with prompts |
| `task_run_logs` | Execution history for scheduled tasks |
| `router_state` | Internal state (timestamps, cursors) |
| `error_log` | Structured error logging |

### The `messages` Table: Input Queue, Not Conversation Store

This is an important architectural distinction. The `messages` table has two roles that are intentionally asymmetric:

**Role 1 — Input queue for the message loop (all channels)**

Incoming user messages from Telegram, WhatsApp, and other channels are written to the `messages` table with `is_bot_message = 0`. The message loop (`getNewMessages()`, `getMessagesSince()`) polls this table — filtered to `is_bot_message = 0` — to detect new messages and trigger container runs. This is the queue mechanism.

Bot responses are NOT stored here for external channels (Telegram, WhatsApp). They flow directly to the platform API (e.g., `bot.api.sendMessage()`). The DB only needs the inbound side to drive the queue.

**Role 2 — Full conversation store for the dashboard channel**

The dashboard channel (`dashboard@internal`) is different: it has no external platform. The dashboard UI polls the DB directly for both sides of the conversation. So `DashboardChannel.sendMessage()` explicitly stores bot responses with `is_bot_message = 1`. This is the only channel that stores outgoing responses.

**No pruning** — the `messages` table is never cleared. It grows indefinitely. For external channels this is low-volume (only inbound messages). For the dashboard channel it includes both sides. If storage becomes a concern, manual pruning or a TTL job would need to be added.

### Known Issue: `is_bot_message` on IPC-Stored Outbound Messages

**Bug (fixed 2026-03-31)**: `src/ipc.ts` `processIpcMessageData()` was storing outbound bot messages (sent via `mcp__nanoclaw__send_message`) with `is_bot_message = false`. Because the message loop filters on `is_bot_message = 0`, these messages re-entered the queue and triggered a second agent run — causing the agent to respond to its own output.

**Fix**: Changed `is_bot_message: false` → `true` in `src/ipc.ts` line ~193.

**Why it matters for new groups**: Any code path that stores a bot-originated message in the `messages` table MUST set `is_bot_message = true`. If it doesn't, the message loop will treat it as a new user message and fire the agent again. The dashboard channel (`DashboardChannel.sendMessage()`) correctly sets `is_bot_message = true` — use that as the reference implementation.

### Session Files vs Database

These serve completely different purposes — the DB is NOT a conversation store for agent memory:

| Store | What | Who Reads It | Format |
|-------|------|-------------|--------|
| `.jsonl` session files | Full conversation transcript (both sides) | Claude Agent SDK only | JSONL (opaque, SDK-internal) |
| SQLite `messages` table | Inbound user messages (queue) + dashboard bot responses | Message loop, dashboard UI | Structured rows |

Agent memory and conversation continuity come entirely from the `.jsonl` session files via SDK session resumption. The DB `messages` table does not feed the agent context. Don't try to parse `.jsonl` files — the format is internal to Claude Code and may change.


---

## Persona Backup

Group state lives in directories ignored by both git and Dropbox (`store/`, `data/`, `groups/`). A daily backup job preserves this irreplaceable state to an external volume.

| What | Backed Up | Skipped |
|------|-----------|---------|
| `store/messages.db` | Yes (via SQLite `.backup` snapshot) | — |
| `data/sessions/` | Yes (transcripts, memory, settings) | `agent-runner-src/` (regenerable) |
| `data/ipc/` | Yes (queues, tasks) | — |
| `groups/` | Yes (CLAUDE.md, memory, media, scripts) | `node_modules/` (regenerable) |
| `.env` | Yes (non-secret config) | — |
| `logs/` | No (ephemeral) | — |

**Schedule:** Daily at 01:00 via `com.nanoclaw.backup-personas` (launchd).

**Destination:** `/Volumes/nanoclaw-personas-bak/` (disk image — user-configurable in `scripts/backup-personas.sh`).

**Safety model:** Three-phase, power-fail safe:
1. SQLite `.backup` creates a transactionally-consistent snapshot.
2. `rsync` stages everything to `.staging/` on the destination (interruptible without harm).
3. `mv` renames `.staging/` to `nanoclaw-YYYY-MM-DD_HHMMSS` atomically (same-filesystem rename is uninterruptible).

**Rotation:** Keeps the last 4 backups. Older ones are deleted automatically.

**Manual run:** `launchctl start com.nanoclaw.backup-personas`

**Restore:** Copy the relevant directories from the backup back into `$NANOCLAW_ROOT/`, then restart the service.

---

## Group Isolation and Container Mounts

### What Each Container Sees

| What | Host Path | Container Path | Who Gets It | Access |
|------|-----------|----------------|-------------|--------|
| Group folder | `<repo>/groups/<folder>/` | `/workspace/group` | Each group gets its own | read-write |
| Sessions | `<repo>/data/sessions/<folder>/.claude/` | `/home/node/.claude` | Each group gets its own | read-write |
| IPC | `<repo>/data/ipc/<folder>/` | `/workspace/ipc` | Each group gets its own | read-write |
| Agent runner | `<repo>/data/sessions/<folder>/agent-runner-src/` | `/app/src` | All groups (copied once per group) | read-write |
| Container skills | `<repo>/container/skills/` | Copied into `~/.claude/skills/` | Per-group selection | read-write |
| Extra mounts | Configured per-group | `/workspace/extra/<name>` | Per-group config | configurable |

Every group gets its own group folder at `/workspace/group` (read-write). There are no implicit project root or global folder mounts — use `additionalMounts` to expose extra filesystem paths to a group.

The agent-runner source is copied into a per-group writable location on first run so agents can customise it without affecting other groups. It's recompiled on container startup via `entrypoint.sh`.

### Per-Group Configuration (`containerConfig`)

Configure group behaviour via the `containerConfig` JSON column in the `registered_groups` table:

```json
{
  "endpoint": "ollama",
  "skills": ["status", "browser"],
  "allowedTools": ["Read", "Grep", "WebSearch"],
  "mcpServers": {
    "brave-search": {
      "command": "node",
      "args": ["/app/mcp-servers/brave-search/dist/index.js"]
    }
  },
  "model": "sonnet",
  "contextWindowSize": 128000,
  "webSearchVendor": "ollama",
  "systemPrompt": "You are a financial analyst. Be concise and data-driven.",
  "timeout": 3600000,
  "additionalMounts": [
    { "hostPath": "~/Documents/finance", "containerPath": "finance", "readonly": true }
  ]
}
```

#### `endpoint` — Per-Group Upstream Vendor

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Routes to `anthropic` (default) |
| `"ollama"` | Routes to the Ollama upstream defined in `secrets.env` |
| `"zai"` | Routes to the Z.ai upstream defined in `secrets.env` |
| `"anthropic"` | Explicit default — same as absent |

The value must match a vendor prefix defined in `secrets.env` (case-insensitive). If the vendor is not found in the routing table, the proxy falls back to `anthropic`. API keys are never exposed to the group config — only the vendor name is stored here.

#### `skills` — Per-Group Skill Selection

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | All skills copied (backward compatible) |
| `[]` | No skills — minimal container |
| `["status", "browser"]` | Only named skills |

**`agent-browser` is special**: it is NOT installed in the Docker image. The binary is stored on the host at `container/binaries/agent-browser/` and mounted into the container only when `agent-browser` is in `allowedSkills` (or `allowedSkills` is undefined). Without the mount, the binary does not exist in the container — agents cannot browse the web via Bash even if they try.

> **Important**: `container/binaries/agent-browser/` MUST be committed to git. It is the only source of the binary at runtime. Do NOT add it to `.gitignore`.

**Telegram groups**: Always include `telegram-formatting` in the skills list to ensure proper markdown rendering. Telegram uses Markdown v1 syntax (`*bold*` not `**bold**`). Do not duplicate formatting rules in CLAUDE.md — the skill is the single source of truth.

```json
{
  "skills": ["capabilities", "status", "telegram-formatting"]
}
```

Similarly, include `slack-formatting` for Slack groups. Discord groups do not need a formatting skill (standard markdown works).

#### `allowedTools` — Per-Group Tool Restrictions

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | All tools (default list) |
| `["Read", "Grep", "WebSearch"]` | Only named tools |
| `[]` | No tools — only MCP IPC |

`mcp__nanoclaw__*` is always included regardless of config (IPC must work).

**How it actually works — `disallowedTools` complement:**

The SDK's `allowedTools` parameter only filters SDK-registered tools. The `claude_code` preset injects additional CLI tools (`Agent`, `CronCreate`, `EnterPlanMode`, etc.) that bypass `allowedTools` entirely. To make the whitelist actually work, the agent-runner computes `disallowedTools` as the complement of `allowedTools` at runtime:

```
disallowedTools = ALL_KNOWN_TOOLS − allowedTools
```

`disallowedTools` reliably blocks any tool, including preset-injected ones. This is computed automatically — you never configure `disallowedTools` directly. When `allowedTools` is absent, `disallowedTools` is empty (all tools allowed).

Full tool reference — use these names in `allowedTools`. This list is also the `ALL_KNOWN_TOOLS` constant in `container/agent-runner/src/index.ts` (update both when upgrading the SDK):

| Category | Tools |
|----------|-------|
| File Operations | `Read`, `Write`, `Edit`, `Glob`, `Grep` |
| Execution | `Bash`, `NotebookEdit` |
| Web | `WebSearch`, `WebFetch` |
| Planning | `EnterPlanMode`, `ExitPlanMode` |
| Tasks | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`, `TaskOutput` |
| Scheduling | `CronCreate`, `CronDelete`, `CronList` |
| Git/Worktree | `EnterWorktree`, `ExitWorktree` |
| Agent Teams | `TeamCreate`, `TeamDelete`, `SendMessage` |
| Agent & Skills | `Agent`, `Skill`, `RemoteTrigger` |
| User Interaction | `AskUserQuestion` |
| Misc | `TodoWrite`, `ToolSearch` |
| Always included | `mcp__nanoclaw__*` (IPC — cannot be removed) |

> **SDK upgrade note**: When upgrading `@anthropic-ai/claude-agent-sdk`, review the tool list and update `ALL_KNOWN_TOOLS` in `container/agent-runner/src/index.ts` and the table above.

#### `disallowedTools` — Auto-Computed, Not Configured

This field is never set manually in `containerConfig`. It is computed at runtime by the agent-runner as the complement of `allowedTools`. Documented here for reference only.

#### Bundled Skills — Known Limitation

The `claude_code` preset ships with built-in skills that are **always available** regardless of `containerConfig.skills`:

`simplify`, `loop`, `claude-api`, `review`, `batch`, `debug`

These are prompt-based playbooks baked into the preset system prompt — not filesystem skills. They cannot be removed via `containerConfig.skills` or any other config. This is an Anthropic-controlled limitation. Reference: `code.claude.com/docs/en/skills`.

The skills in `container/skills/` (e.g. `agent-browser`, `status`) are separate — these are filesystem-based and are fully controlled by `containerConfig.skills`.

#### `mcpServers` — Per-Group MCP Servers

Add additional MCP servers to a group's container alongside the always-present `nanoclaw` IPC server.

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "node",
      "args": ["/app/mcp-servers/brave-search/dist/index.js"]
    }
  }
}
```

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Only `nanoclaw` IPC server |
| `{ "brave-search": { ... } }` | Adds Brave Search alongside nanoclaw |

The `nanoclaw` server is always present and cannot be overridden — if a group config includes a key named `nanoclaw`, it is silently ignored.

**Brave Search MCP**: A self-built MCP server at `container/mcp-servers/brave-search/` that wraps the Brave Search API. Provides the `mcp__brave-search__brave_search` tool. The API key (`BRAVE_SEARCH_API_KEY`) is read from `~/.config/nanoclaw/secrets.env` on the host and injected as a container env var — the container never sees the host secrets file. Brave API calls go directly from the container to `api.search.brave.com`, not through the credential proxy.

#### `model` — Per-Group Model Override

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Inherit from `settings.json` (`ANTHROPIC_MODEL`) |
| `"sonnet"` | Use Claude Sonnet |
| `"haiku"` | Use Claude Haiku (faster, cheaper) |

The default model is set in `data/sessions/<folder>/.claude/settings.json` (currently `glm-5:cloud`). Per-group `model` overrides this at the SDK level.

**`settings.json` format:**

```json
{
  "env": {
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1"
  }
}
```

Values live inside the `env` object — the SDK reads `settings.json` as a nested `{ env: { ... } }` structure. Do not write keys at the top level (e.g. `{ "ANTHROPIC_MODEL": "..." }`) — the SDK will ignore them.

#### `systemPrompt` — Per-Group Persona

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Preset prompt only |
| `"You are X..."` | Append to claude_code preset prompt |

#### `contextWindowSize` — Context Flush Threshold

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | Default: 128000 tokens |
| `64000` | Smaller context model — flush sooner |
| `200000` | Larger context model — flush later |

Controls when automatic context flushing triggers. Auto-flush fires at 80% of this value during live conversations. Nightly maintenance flushes at 50%. See [Context Management](#context-management) for details.

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.contextWindowSize', 200000) WHERE folder = 'mygroup'"
```

#### `webSearchVendor` — Web Search Upstream

| Value | Behaviour |
|-------|-----------|
| `undefined` / absent | No web search vendor configured (built-in `WebSearch`/`WebFetch` used if Anthropic endpoint; silently fails otherwise) |
| `"ollama"` | Route web search traffic through the Ollama web search upstream |

Must match a `{VENDOR}_WEB_SEARCH_BASE_URL` / `{VENDOR}_WEB_SEARCH_API_KEY` pair in `secrets.env`. Requires `nanoclaw-web-search` in `mcpServers` to actually expose the tools to the agent. See [Web Search Proxy](#web-search-proxy) for setup details.

#### `telegramBot` — Per-Group Named Telegram Bot

For groups that use a secondary Telegram bot (not the default bot), set the bot name here. The name maps to `TELEGRAM_{NAME}_BOT_TOKEN` in `secrets.env` (case-insensitive).

```json
{ "telegramBot": "fin" }
```

The bot token env var would be `TELEGRAM_FIN_BOT_TOKEN=...`. When the group sends outbound messages, NanoClaw uses this bot instead of the default `TELEGRAM_BOT_TOKEN`.

**Virtual JIDs for named bots:** When registering a group with a named bot, the JID includes the bot name suffix: `tg:123456789:fin`. The `/chatid` command in the bot outputs this virtual JID. Use it verbatim during registration:

```bash
npx tsx setup/index.ts --step register -- --jid "tg:123456789:fin" --name "Fin Group" --folder "fin" --channel telegram --bot-token-name fin
```

Groups registered with plain JIDs (no `:botName` suffix) fall back to `containerConfig.telegramBot` or the default bot.

---

## Host Commands

Host commands are intercepted on the host process before reaching the agent container. They work across all channels (Telegram, WhatsApp, Slack, etc.) and are gated per-group via an explicit allowlist.

### `/model` — Switch Model Preset

Enable it for a group by adding `allowedHostCommands: ['model']` to the group's `containerConfig`:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.allowedHostCommands', json_array('model')) WHERE folder = 'mygroup'"
```

Then send `/model` in the group to see the active preset and available choices, or `/model <preset>` to switch.

Define presets in `~/.config/nanoclaw/model-presets.json`:

```json
{
  "ollama_k2.6": {
    "endpoint": "ollama",
    "model": "kimi-k2.6:cloud"
  },
  "opus_4.7": {
    "endpoint": "anthropic",
    "model": "claude-opus-4-7"
  }
}
```

Only `model` and `endpoint` are updated — all other `containerConfig` fields (skills, allowedTools, systemPrompt, etc.) are preserved. The active container is recycled on switch so the next message spawns a fresh container with the new config.

**Session sanitization on switch:** When switching models, NanoClaw automatically sanitizes the session `.jsonl` transcript in two ways:

1. **Tool ID sanitization:** Non-compliant `tool_use` IDs (e.g. `functions.Bash:1` from Ollama) are rewritten to match `^[a-zA-Z0-9-]+$` so Anthropic can resume the session.
2. **Thinking block stripping:** `thinking` and `redacted_thinking` blocks (which carry model-specific cryptographic signatures) are removed so the new model can safely resume the session without signature validation errors.

This preserves conversation history while making cross-model session resumption safe.

**Security:** `allowedHostCommands` is `undefined` by default, which means no host commands are allowed. Senders must also pass the sender allowlist check.

---

## How the Agent SDK Is Invoked

The agent-runner inside each container uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) directly — it does NOT shell out to the `claude` CLI. This means Claude Code agent profiles (`.claude/agents/*.md`) are not used.

| Option | Source | Default | Per-Group? |
|--------|--------|---------|------------|
| `allowedTools` | `containerConfig.allowedTools` | Full tool list | Yes |
| `disallowedTools` | Auto-computed as complement of `allowedTools` | Empty (all allowed) | Yes |
| `model` | `containerConfig.model` → `settings.json` env | `glm-5:cloud` | Yes |
| `contextWindowSize` | `containerConfig.contextWindowSize` | 128000 | Yes |
| `systemPrompt` | `claude_code` preset + `containerConfig.systemPrompt` | Preset only | Yes |
| `resume` | `sessionId` from SQLite | None (new session) | Per-group |
| `permissionMode` | Hardcoded | `bypassPermissions` | No |
| `mcpServers` | `nanoclaw` (hardcoded) + `containerConfig.mcpServers` | NanoClaw IPC server only | Yes |
| `cwd` | Hardcoded | `/workspace/group` | Per-group folder |
| `settingSources` | Hardcoded | `['project', 'user']` | No |

---

## Credential Security

### Credential Philosophy

`~/.config/nanoclaw/secrets.env` is the single source of truth for ALL secrets. This includes:

- Model provider API keys (`ANTHROPIC_API_KEY`, `OLLAMA_API_KEY`, `ZAI_API_KEY`)
- Channel tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DISCORD_BOT_TOKEN`)
- Web search keys (`*_WEB_SEARCH_API_KEY`)
- Any other sensitive credentials

The `.env` file in the project root is for non-sensitive config only (e.g., `TZ=Europe/London`). Never put secrets in `.env`.

`readEnvFile()` in `src/env.ts` reads `secrets.env` first, then `.env`, then `process.env`. Secrets in `secrets.env` always take priority.

### How the Proxy Works

Containers never see real API keys or tokens. The credential proxy (`src/credential-proxy.ts`) runs on the host and intercepts all API traffic:

1. Container sends requests to `http://host.docker.internal:3001` with a placeholder key
2. Credential proxy replaces the placeholder with the real key from `~/.config/nanoclaw/secrets.env`
3. Proxy forwards to the correct upstream API based on the requested vendor

The `.env` file in the project root is shadowed by `/dev/null` in main group containers to prevent agents from reading it.

### Auth Modes: API Key vs OAuth

The credential proxy supports two authentication modes. The mode is auto-detected at startup by `detectAuthMode()` in `src/credential-proxy.ts`:

| Condition | Detected Mode | Container Env Var |
|-----------|---------------|-------------------|
| `ANTHROPIC_API_KEY` found in secrets.env / .env / process.env | `api-key` | `ANTHROPIC_API_KEY=placeholder` |
| `ANTHROPIC_API_KEY` NOT found anywhere | `oauth` | `CLAUDE_CODE_OAUTH_TOKEN=placeholder` |

How each mode works inside the container:

- **API key mode**: The SDK sends `x-api-key: placeholder` on every request. The proxy strips it and injects the real API key from the routing table. Simple, stateless.
- **OAuth mode**: The SDK exchanges the placeholder Bearer token for a temporary API key via `/api/oauth/claude_cli/create_api_key`. The proxy injects the real OAuth token on that exchange request. Subsequent requests use the temp key directly.

#### The Anthropic Placeholder Requirement (Non-Anthropic Endpoints)

> **This is a common setup pitfall on fresh installs.**

When using a non-Anthropic endpoint (Ollama, Z.ai, etc.) as your primary provider, you still need `ANTHROPIC_API_KEY` set in `secrets.env` — even if you never call Anthropic's API.

Why: `detectAuthMode()` only checks for `ANTHROPIC_API_KEY`. If it's absent, the proxy assumes OAuth mode and the container receives `CLAUDE_CODE_OAUTH_TOKEN=placeholder`. The Claude CLI inside the container sees this OAuth token and attempts a token exchange against the proxy. Since the proxy is routing to Ollama (which doesn't implement OAuth exchange), the CLI falls back to prompting for login — the container hangs or errors with an authentication prompt.

**Fix:** Always include an `ANTHROPIC_API_KEY` entry in `secrets.env`:

```bash
# Forces api-key auth mode even when not using Anthropic
ANTHROPIC_API_KEY=placeholder
```

If you ARE using Anthropic as one of your endpoints, the real key serves double duty (routing table + auth mode detection). If you're NOT using Anthropic at all, `placeholder` is sufficient — it just needs to be non-empty so `detectAuthMode()` returns `api-key`.

### Multi-Endpoint Routing

The proxy supports multiple upstream vendors. At startup it scans `secrets.env` (and `.env` fallback) for all `{VENDOR}_BASE_URL` / `{VENDOR}_API_KEY` pairs and builds an in-memory routing table keyed by lowercase vendor name.

Configure vendors in `~/.config/nanoclaw/secrets.env`:

```bash
# Auth mode anchor — MUST be present even if not using Anthropic directly.
# Use the real key if you have one, or "placeholder" if not.
ANTHROPIC_API_KEY=placeholder

# Anthropic (only if using Anthropic as an endpoint)
ANTHROPIC_BASE_URL=https://api.anthropic.com
# ANTHROPIC_API_KEY already set above — use the real key instead of "placeholder"

# Ollama — NO trailing path, NO /v1 suffix
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_API_KEY=ollama

# Z.ai
ZAI_BASE_URL=https://api.z.ai
ZAI_API_KEY=...
```

Each request from a container includes an `X-Nanoclaw-Endpoint` header with the vendor name. The proxy reads this header, selects the matching upstream URL and API key, strips the header before forwarding, and injects the real credential. If the header is absent or the vendor is unknown, it falls back to `anthropic`.

Groups select their vendor via `containerConfig.endpoint` (see below). The container-facing `ANTHROPIC_BASE_URL` always points to the proxy — groups never need to know the real upstream URL.

> The routing table is built once at proxy startup and held in memory only. Vendor names are lowercased to prevent case-based bypass. The `X-Nanoclaw-Endpoint` header is stripped before forwarding to prevent leakage.

### Endpoint URL Format — What Goes in `secrets.env`

The credential proxy concatenates the base URL pathname with the SDK's request path:

```
finalPath = basePath (from BASE_URL, trailing slash stripped) + req.url (from SDK/MCP)
```

This means the `_BASE_URL` value must contain ONLY the scheme + host + port, plus any path prefix that the upstream expects BEFORE the SDK-appended path. Do NOT include path segments that the SDK or MCP server will add.

#### LLM Inference Endpoints

The Claude Agent SDK sends requests to paths like `/v1/messages`. The proxy prepends the base URL pathname:

| `secrets.env` value | SDK sends | Final upstream path | Result |
|---------------------|-----------|---------------------|--------|
| `http://localhost:11434` | `/v1/messages` | `/v1/messages` | Correct |
| `http://localhost:11434/v1` | `/v1/messages` | `/v1/v1/messages` | **BROKEN — double /v1** |
| `https://api.anthropic.com` | `/v1/messages` | `/v1/messages` | Correct |
| `https://api.z.ai/api/anthropic` | `/v1/messages` | `/api/anthropic/v1/messages` | Correct (Z.ai needs the prefix) |

**Rule for Ollama:** Use `http://localhost:11434` — no `/v1`, no trailing slash. The SDK adds `/v1/messages` itself.

**Rule for other providers:** Include only the path prefix the provider requires BEFORE `/v1/`. If the provider's API is at the root (like Anthropic), use just the host.

#### Web Search Endpoints

The `nanoclaw-web-search` MCP server sends requests to `/web_search` and `/web_fetch`. The proxy prepends the web search base URL pathname:

| `secrets.env` value | MCP sends | Final upstream path | Result |
|---------------------|-----------|---------------------|--------|
| `https://ollama.com/api` | `/web_search` | `/api/web_search` | Correct |
| `https://ollama.com/api/` | `/web_search` | `/api/web_search` | Correct (trailing slash stripped) |

**Rule for web search:** Include the API path prefix. The MCP server appends `/web_search` or `/web_fetch`.

#### Complete Ollama Example

```bash
# ~/.config/nanoclaw/secrets.env

# Auth mode anchor
ANTHROPIC_API_KEY=placeholder

# LLM inference — bare host, NO /v1
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_API_KEY=ollama

# Web search — includes /api prefix
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api
OLLAMA_WEB_SEARCH_API_KEY=your-ollama-web-key
```

### SDK Header Injection — `ANTHROPIC_CUSTOM_HEADERS`

The agent-runner sets `ANTHROPIC_CUSTOM_HEADERS` in the SDK environment to forward the endpoint name to the proxy:

```
ANTHROPIC_CUSTOM_HEADERS=X-Nanoclaw-Endpoint: anthropic
```

The format is newline-delimited `Header-Name: value` pairs. Note: `ANTHROPIC_DEFAULT_HEADERS` (JSON format) is **not** supported by the Claude Agent SDK — use `ANTHROPIC_CUSTOM_HEADERS` only.

### Web Search Proxy

Claude's built-in `WebSearch` and `WebFetch` tools are Anthropic server-side tools (`type: "server_tool_use"`). Anthropic executes them during `/v1/messages` processing. **Non-Anthropic endpoints (Ollama, Z.ai, etc.) do not implement this mechanism — built-in web search silently fails.**

> **Critical for non-Anthropic groups:** You MUST:
> 1. Remove `WebSearch` and `WebFetch` from `allowedTools` (or explicitly exclude them)
> 2. Add the `nanoclaw-web-search` MCP server to `containerConfig.mcpServers`
> 3. Set `webSearchVendor` in `containerConfig`
>
> If you don't do this, agents will attempt to use the built-in tools, get no results, and silently degrade.

A dedicated MCP server (`nanoclaw-web-search`) provides `mcp__nanoclaw-web-search__web_search` and `mcp__nanoclaw-web-search__web_fetch` tools as replacements. Requests are routed through the credential proxy so API keys never reach the container.

**Setup:**

1. Add a web search vendor to `secrets.env` (see [Endpoint URL Format](#endpoint-url-format--what-goes-in-secretsenv) for correct URL format):

```bash
# Web search — includes API path prefix
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api
OLLAMA_WEB_SEARCH_API_KEY=your-ollama-web-key
```

2. Enable for a group via `containerConfig`:

```json
{
  "webSearchVendor": "ollama",
  "mcpServers": {
    "nanoclaw-web-search": {
      "command": "node",
      "args": ["/app/mcp-servers/nanoclaw-web-search/dist/index.js"]
    }
  }
}
```

3. The agent-runner automatically sets `NANOCLAW_WEB_SEARCH_VENDOR` and `X-Nanoclaw-Web-Search-Vendor` header when `webSearchVendor` is configured.

**Routing:** The credential proxy intercepts `/web_search` and `/web_fetch` paths, resolves the vendor from the `X-Nanoclaw-Web-Search-Vendor` header, injects credentials, and forwards to the upstream. If the header is absent, falls back to `ollama`.

**After enabling:** Rebuild the Docker image, clear cached agent-runner source, kill running containers, and clear sessions for the group to load fresh MCP tool definitions.

---

## Security Configuration

NanoClaw's primary security boundary is container isolation — agents run in ephemeral Linux containers with only explicitly mounted directories visible. The features below add defence-in-depth layers on top of that boundary. All are controlled via `containerConfig` flags and default to secure behaviour (existing groups are unaffected).

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `ssrfProtection` | `boolean \| SsrfConfig` | `true` | SSRF protection for outbound `web_fetch` requests |
| `injectionScanMode` | `'off' \| 'warn' \| 'block'` | `'warn'` | Prompt injection scanning for context files before container launch |
| `approvalMode` | `boolean` | `false` | Dangerous command approval via messaging channel |
| `approvalTimeout` | `number` (10–600) | `120` | Seconds before an approval request auto-denies |
| `commandAllowlist` | `string[]` | `[]` | Regex patterns for commands that skip approval |
| `learningLoop` | `boolean \| 'extract-only'` | `false` | Skill extraction during memory flush |
| `contextWindowSize` | `number` | `128000` | Token threshold for auto-flush (80% live, 50% nightly) |
| `webSearchVendor` | `string` | `undefined` | Routes web search through named vendor's proxy endpoint |
| `telegramBot` | `string` | `undefined` | Named Telegram bot instance for this group's outbound replies |
| `allowedHostCommands` | `string[]` | `undefined` = none | Per-group host command allowlist. `['model']` enables `/model` to switch presets |

Example with all security flags:

```json
{
  "ssrfProtection": { "allowPrivateNetworks": false },
  "injectionScanMode": "block",
  "approvalMode": true,
  "approvalTimeout": 60,
  "commandAllowlist": ["^git\\b", "^npm run test$"],
  "learningLoop": true
}
```

Invalid values log a warning and fall back to the secure default (`validateContainerConfig()` in `src/lib/config-validator.ts`). No database migration is needed — the `containerConfig` JSON column is schema-less.

### SSRF Protection

Prevents agents from making outbound web requests to internal networks, cloud metadata endpoints, and dangerous schemes.

**What it blocks:**
- RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Loopback (127.0.0.0/8, ::1)
- Link-local (169.254.0.0/16 — includes AWS/GCP metadata at 169.254.169.254)
- CGNAT / shared address space (100.64.0.0/10 — Tailscale, WireGuard)
- Cloud metadata hostnames (`metadata.google.internal`, `metadata.goog`, etc.)
- Non-HTTP schemes (file://, ftp://, gopher://, etc.)
- IPv6-mapped IPv4 bypass attempts (::ffff:127.0.0.1, hex notation)

**Where validation happens:** `validateUrl()` in `src/lib/ssrf-validator.ts`, copied into the `nanoclaw-web-search` MCP server package (`container/mcp-servers/nanoclaw-web-search/`). Validation runs inside `proxyWebFetch()` — the sole agent-controlled URL entry point. Brave Search and the credential proxy are operator-controlled and out of scope.

**Fail-closed:** If DNS resolution fails, the request is blocked (not allowed through).

**Configuration:**

| `ssrfProtection` value | Behaviour |
|------------------------|-----------|
| `undefined` / absent | Enabled with defaults (secure by default) |
| `true` | Enabled with defaults |
| `false` | Disabled (for groups that intentionally need internal network access) |
| `{ allowPrivateNetworks: true }` | Enabled but allows RFC 1918 / loopback |
| `{ additionalBlockedHosts: ["evil.com"] }` | Block additional hostnames |
| `{ additionalAllowedHosts: ["internal.corp"] }` | Exempt specific hosts from the blocklist |

Config pipeline: `containerConfig.ssrfProtection` → `buildContainerArgs()` serialises to `NANOCLAW_SSRF_CONFIG` env var → MCP server's `parseSsrfConfig()` deserialises at startup.

### Prompt Injection Scanning

Scans context files on the host before container launch. Detects patterns that could manipulate agent behaviour via poisoned memory or CLAUDE.md files.

**What it scans:** `CLAUDE.md`, `memory/*.md` (MEMORY.md, COMPACT.md, daily notes), and `global/CLAUDE.md` — discovered by `discoverContextFiles()` in `src/lib/context-scanner.ts`. Files are truncated at 100KB for scanning.

**Detection patterns (critical):**
- Instruction override attempts ("ignore previous instructions", "you are now", "new instructions")
- Credential exfiltration via curl/wget (commands referencing .env, secrets, .ssh, API keys)
- Secret file reads (cat/less/source targeting credential files)
- Base64-encoded command execution (obfuscated shell payloads)
- Claude Code settings.json override attempts

**Detection patterns (warning):**
- Suspicious HTML comments containing keywords like "system", "prompt", "secret"
- Invisible Unicode characters (zero-width spaces, joiners)
- Bidirectional text override characters (can hide content direction)
- Hidden HTML content (display:none, visibility:hidden, opacity:0)
- Unusually long lines (>5000 chars that could hide content)

**Three modes:**

| `injectionScanMode` | Behaviour |
|----------------------|-----------|
| `'off'` | Skip scanning entirely |
| `'warn'` (default) | Log findings, continue with container launch |
| `'block'` | Abort container launch on critical findings |

**Alert notification:** When findings are detected and `NANOCLAW_ALERT_JID` is set, a summary is sent to that messaging channel via `routeOutbound()`. Degrades gracefully if the channel is unavailable.

**Where it runs:** `scanContextFiles()` is called in `runAgent()` (`src/index.ts`) before `runContainerAgent()`. This is a host-side check — the scanner never runs inside the container.

### Command Approval

Adds a human-in-the-loop gate for dangerous shell commands in groups with write-access to real host data.

**When it applies:** Groups with `approvalMode: true` AND write-access `additionalMounts`. If a group has no write mounts, approval mode has no practical effect (all commands target container-internal paths, which are always allowed).

**How it works:**
1. When `approvalMode: true`, `Bash` is removed from `allowedTools` in `runAgent()` and replaced with `mcp__nanoclaw__execute_command` — an MCP tool defined in `container/agent-runner/src/ipc-mcp-stdio.ts`.
2. The agent uses `execute_command` instead of `Bash`. The tool runs `isDangerousCommand()` from `src/lib/command-approval.ts` against the command.
3. If the command is dangerous AND targets a write-mounted path (under `/workspace/extra/`), the tool pauses and writes an `approval_request` to the IPC messages directory.
4. The host's `processIpcMessageData()` picks up the request, formats it, and sends it to the user's messaging channel.
5. The user responds yes/no (or approve/deny/y/n). `checkApprovalResponse()` matches the response and writes an `_approval_response` file to the group's IPC input directory.
6. The MCP tool polls for the response. If approved, the command executes. If denied or timed out, the command is rejected.

**Dangerous command categories (20 patterns across 6 categories):**
- File destruction: `rm -rf`, `find -delete`, `xargs rm`
- Permissions: `chmod 777`, `chown -R root`
- Data modification: `sed -i`, `mv`, `cp`, output redirects
- SQL destructive: `DROP TABLE`, `DELETE FROM` (without WHERE), `TRUNCATE`
- Remote code execution: `curl | bash`, `wget | sh`, process substitution
- Shell/script eval: `bash -c`, `python -e`, `node -e`

**Container-internal paths are always allowed.** The container itself is the security boundary — commands that only affect `/workspace/group/` or other container paths do not require approval. Only commands referencing write-mounted paths (real host data at `/workspace/extra/`) trigger the approval flow.

**Fail-closed:** If the approval request times out (`approvalTimeout`, default 120s), the command is auto-denied. One pending approval per user at a time — a new request auto-denies any previous pending request.

**`commandAllowlist`:** Regex patterns for commands that skip approval even when `approvalMode` is enabled. Validated at startup — invalid regex patterns are silently dropped.

### Sender Allowlist

Controls who can trigger the agent in each group. Configured via `~/.config/nanoclaw/sender-allowlist.json`:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "tg:123456789": { "allow": "6013943815", "mode": "drop", "logDenied": true },
    "tg:123456789:fin": { "allow": "6013943815", "mode": "trigger" }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `default` | object | Fallback for unlisted chats |
| `chats.{jid}` | object | Per-chat override |
| `allow` | string | `"*"` = anyone, `"6013943815"` = specific sender only |
| `mode` | string | `"trigger"` = trigger word required, `"drop"` = silently drop non-allowed senders |
| `logDenied` | boolean | Log dropped messages (default: false) |

The `default.allow` field can also be an array: `["6013943815", "9876543210"]`.

**How it works:**
- `trigger` mode: allowed senders can trigger the bot with the group's trigger word. Non-allowed senders' messages are stored but not processed.
- `drop` mode: messages from non-allowed senders are silently discarded before storage (no DB row, no processing).
- Host commands (`/model`, etc.) also require sender allowlist approval.

### Learning Loop (Skill Extraction)

Enables agents to extract reusable patterns from successful sessions and persist them as skill files for future use.

**How it works:**
1. When `containerConfig.learningLoop` is truthy, the flush prompt (`buildFlushPrompt()`) includes a skill extraction step as step 1 (before memory/compact/daily-note).
2. The agent reviews the session for reusable patterns and writes up to 2 skill files to `extracted-skills/[skill-name].md` in the group folder.
3. Each skill file has YAML frontmatter (`name`, `extracted`, `source_group`, `confidence`) and sections: When to Use, Pattern, Example, Notes.
4. After flush, the host sends a notification to the group channel listing any skills extracted today.

**Skill loading at next session:**
- `registerGroup()` creates `extracted-skills/` in the group folder.
- `buildVolumeMounts()` copies valid extracted skill files into `skills/extracted/` (inside the session's `.claude/skills/` directory) when `learningLoop === true` (strict equality).
- `false`, `undefined`, and `'extract-only'` all skip loading — `'extract-only'` extracts skills during flush but does not load them into future sessions.

**Skill quality guide:** `container/skills/learning-loop/SKILL.md` defines the format, quality criteria, and confidence levels. Loaded when `learningLoop` is enabled.

**File locations:**
- Extracted skills: `groups/{folder}/extracted-skills/*.md`
- Skill reader: `src/lib/skill-manager.ts` (`getExtractedSkills()`)
- Flush prompt builder: `src/lib/flush-prompt.ts` (`buildFlushPrompt()`)
- Container copy: `container/agent-runner/src/lib/flush-prompt.ts`
- Skill format guide: `container/skills/learning-loop/SKILL.md`

---

## Workspace Layout

```
$NANOCLAW_ROOT/
├── .env                             ← timezone and non-secret config
├── groups/                          ← group folders (mounted into containers)
│   ├── main/CLAUDE.md               ← main group personality
│   ├── global/CLAUDE.md             ← shared context (non-main groups)
│   ├── dashboard/
│   └── telegram_main/
│       ├── CLAUDE.md                ← group personality (includes @import for memory)
│       ├── memory/                  ← persistent agent memory
│       │   ├── MEMORY.md            ← durable facts (survives session reset)
│       │   ├── COMPACT.md           ← session summary (overwritten on flush)
│       │   └── YYYY-MM-DD.md        ← daily notes
│       ├── extracted-skills/        ← skills extracted by learning loop (when enabled)
│       └── token-usage.log          ← input/output token counts per message
├── data/
│   ├── sessions/<folder>/
│   │   ├── .claude/
│   │   │   ├── settings.json        ← Claude Code settings (model, features)
│   │   │   ├── skills/              ← copied from container/skills/
│   │   │   └── projects/
│   │   │       └── -workspace-group/
│   │   │           ├── <uuid>.jsonl  ← session transcript
│   │   │           └── memory/       ← auto-memory files
│   │   └── agent-runner-src/         ← per-group agent-runner copy
│   └── ipc/<folder>/                 ← per-group IPC namespace
├── container/
│   ├── skills/                       ← filesystem skills (copied per-group)
│   │   ├── agent-browser/
│   │   ├── capabilities/
│   │   ├── learning-loop/            ← skill extraction format guide (when learningLoop enabled)
│   │   ├── slack-formatting/
│   │   ├── telegram-formatting/
│   │   └── status/
│   ├── binaries/                     ← host-stored binaries (NOT in Docker image)
│   │   └── agent-browser/            ← MUST be committed to git (51MB) — runtime source
│   ├── mcp-servers/                  ← self-built MCP servers (built into Docker image)
│   │   ├── brave-search/             ← Brave Search API wrapper
│   │   └── nanoclaw-web-search/      ← Web search via credential proxy (any vendor)
│   ├── agent-runner/                 ← runs inside containers
│   └── Dockerfile
├── store/
│   └── messages.db                   ← SQLite (messages, groups, sessions, tasks)
├── logs/                             ← service logs (stdout.log)
└── src/                              ← NanoClaw source code
```

Inside a running container:

```
/workspace/
├── group/           ← group's folder (read-write, WORKDIR)
│   ├── CLAUDE.md    ← group personality (includes @import for memory)
│   ├── memory/      ← persistent agent memory
│   │   ├── MEMORY.md    ← durable facts
│   │   ├── COMPACT.md   ← session summary
│   │   └── YYYY-MM-DD.md ← daily notes
│   └── token-usage.log  ← token counts per message
├── ipc/             ← per-group IPC (messages, tasks, input)
└── extra/           ← additional mounts (if configured)

/home/node/.claude/
├── settings.json    ← Claude Code settings
├── skills/          ← copied from container/skills/
└── projects/
    └── -workspace-group/
        └── <uuid>.jsonl  ← session transcript
```

The project hash `-workspace-group` is derived from the container WORKDIR (`/workspace/group`).

---

## Group Creation Checklist

The `register_group` MCP tool (and the `/add-internal-group` skill) registers a group in SQLite and creates the group folder. However, it does NOT automatically create the `CLAUDE.md` file, the `memory/` directory, or the memory seed files. These must be created manually or the agent will start without instructions and the `@import` directives will fail silently.

### What `register_group` Creates

- Row in `registered_groups` table (name, folder, trigger, containerConfig)
- Row in `chats` table (for internal groups only — external channels create this via their channel adapter)
- The group folder at `groups/{folder}/` (created by `container-runner.ts` on first container spawn)

### What You Must Create Manually

After registering a group, create these files:

#### 1. `groups/{folder}/CLAUDE.md`

Use the global template (`groups/global/CLAUDE.md`) as the base for non-main groups. Use the main template (`groups/main/CLAUDE.md`) for main groups. The key sections that MUST be present:

- Agent identity and personality
- Response delivery paths (text output vs `send_message`)
- Acknowledge-before-working rule
- Routed messages handling
- Delegated tasks handling (if the group participates in delegation)
- `<internal>` tag usage
- **Memory Protocol** — with `@import` directives:

```markdown
## Memory Protocol

@memory/MEMORY.md
@memory/COMPACT.md

You have a persistent memory system at `memory/`.

- `memory/MEMORY.md` — durable facts (preferences, names, decisions). Write here immediately when you learn something lasting. Keep it concise — one line per fact.
- `memory/YYYY-MM-DD.md` — daily running notes (task state, observations, context from today's conversations). Create the file if it doesn't exist. Append, don't overwrite.

Before ending any response where something important was discussed, check: should this be written to memory?
```

The `@memory/MEMORY.md` and `@memory/COMPACT.md` lines are `@import` directives — the SDK expands them at container spawn time. If the files don't exist, the import silently resolves to empty content (no error, but no memory either).

- Channel-specific formatting rules (or reference to the formatting skill)

#### 2. `groups/{folder}/memory/MEMORY.md`

Create the directory and seed file:

```bash
mkdir -p groups/{folder}/memory
echo "# Memory" > groups/{folder}/memory/MEMORY.md
```

This file is where the agent writes durable facts. Without it, the first flush will create it, but the agent won't have memory context until then.

#### 3. `groups/{folder}/memory/COMPACT.md` (optional)

```bash
echo "# Compact" > groups/{folder}/memory/COMPACT.md
```

This is overwritten on each flush. Creating it upfront avoids a missing-file warning on the first `@import` expansion, though the SDK handles missing imports gracefully.

### Quick Setup Script

For a new non-main group:

```bash
FOLDER="telegram_mygroup"
mkdir -p groups/$FOLDER/memory
cp groups/global/CLAUDE.md groups/$FOLDER/CLAUDE.md
echo "# Memory" > groups/$FOLDER/memory/MEMORY.md
echo "# Compact" > groups/$FOLDER/memory/COMPACT.md
```

Then edit `groups/$FOLDER/CLAUDE.md` to customise the agent's identity and add any group-specific instructions.

### Non-Anthropic Groups — Additional Setup

For groups using a non-Anthropic endpoint (e.g. `containerConfig.endpoint = "ollama"`), you must also configure web search correctly. See [Web Search Proxy](#web-search-proxy) for the full setup. Summary:

1. Ensure `ANTHROPIC_API_KEY=placeholder` is in `secrets.env` (see [Auth Modes](#auth-modes-api-key-vs-oauth))
2. Add `nanoclaw-web-search` MCP server to `containerConfig.mcpServers`
3. Set `containerConfig.webSearchVendor`
4. Remove `WebSearch` and `WebFetch` from `allowedTools` if you're using a custom tool list — or if using the default tool list, the built-in tools will be present but non-functional (they'll silently return nothing). The MCP tools (`mcp__nanoclaw-web-search__web_search`, `mcp__nanoclaw-web-search__web_fetch`) work regardless.

---

## Useful Commands

```bash
# Restart NanoClaw (rebuild + restart via launchd)
cd $NANOCLAW_ROOT && npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Stop / Start NanoClaw
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Check running agent containers
docker ps --filter "name=nanoclaw"

# Force-stop a stuck container
docker stop $(docker ps --filter "name=nanoclaw-telegram-main" -q)

# View NanoClaw service logs
tail -f $NANOCLAW_ROOT/logs/stdout.log

# Open Claude Code for NanoClaw config
cd $NANOCLAW_ROOT && claude
```

### Clearing Chat History for a Group

To start fresh without recreating the group:

```bash
# 1. Delete session row from database
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='<folder>'"

# 2. Delete transcript files
rm -f data/sessions/<folder>/.claude/projects/-workspace-group/*.jsonl

# 3. (Optional) Clear auto-memory
rm -f data/sessions/<folder>/.claude/projects/-workspace-group/memory/*.md

# 4. Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

> Auto-memory survives session resets by design — skip step 3 if you want to keep learned preferences.

For `telegram_main`:

```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='telegram_main'"
rm -f data/sessions/telegram_main/.claude/projects/-workspace-group/*.jsonl
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

### When to rebuild what

NanoClaw has two build targets — the host process and the container image.

| What changed | Action needed |
|-------------|---------------|
| `src/` (host code) | `npm run build` + restart service |
| `container/agent-runner/` (code inside containers) | `./container/build.sh` |
| `container/skills/` (skills loaded into containers) | `./container/build.sh` |
| `container/mcp-servers/` (MCP servers built into image) | `./container/build.sh` |
| `container/Dockerfile` | `./container/build.sh` |
| `container/binaries/agent-browser/` | No rebuild needed — mounted at runtime |
| Both `src/` and `container/` | `npm run build` + `./container/build.sh` + restart service |

If you only change host code, you do NOT need to rebuild the container image. If you only change container code, you do NOT need to restart the service (new containers pick up the new image automatically).

---

## Integration Notes for Kiro

When working on NanoClaw tasks:

- NanoClaw codebase lives at `$NANOCLAW_ROOT/`
- Mount configuration is in `src/container-runner.ts` (`buildVolumeMounts()`)
- Group registration and `containerConfig` are in the `registered_groups` SQLite table
- The agent-runner at `container/agent-runner/src/index.ts` controls SDK invocation
- Session IDs flow: container output → `src/index.ts` → SQLite `sessions` table → next container input
- To expose external data to agents: use `containerConfig.additionalMounts` (validated against `~/.config/nanoclaw/mount-allowlist.json`)
- Build + restart cycle: `npm run build` then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Tests: `npm test` (vitest, currently ~360 tests)
- Multi-endpoint routing table is built by `scanEndpoints()` in `src/env.ts` — scans all `{VENDOR}_BASE_URL` / `{VENDOR}_API_KEY` pairs from `secrets.env` at proxy startup
- Context flush: agent-runner checks `input_tokens` against `contextWindowSize` (80% live, 50% nightly); `src/nightly-maintenance.ts` orchestrates nightly cron
- Delegation: `delegations` table + `delegate_to_group`/`respond_to_group` MCP tools; `multi_agent_router` flag enables hub routing
- Web search: `nanoclaw-web-search` MCP server + `{VENDOR}_WEB_SEARCH_BASE_URL`/`{VENDOR}_WEB_SEARCH_API_KEY` in secrets.env
- Auth mode: `detectAuthMode()` in `src/credential-proxy.ts` checks for `ANTHROPIC_API_KEY` — must be present (even as `placeholder`) for non-Anthropic endpoints to avoid OAuth login prompt
- Endpoint URLs: LLM base URLs must NOT include `/v1` (SDK adds it); web search base URLs SHOULD include the API path prefix (MCP server adds `/web_search` or `/web_fetch`)
- Group creation: `register_group` does NOT create `CLAUDE.md` or `memory/` — these must be created manually using the global/main template
- Skills: `container/skills/capabilities/SKILL.md` and `container/skills/status/SKILL.md` list web search tools as `mcp__nanoclaw-web-search__*` — these are only available when the group has the MCP server configured via `containerConfig.mcpServers`
- Security features: SSRF (`src/lib/ssrf-validator.ts`), injection scanning (`src/lib/context-scanner.ts` + `src/lib/injection-scanner.ts`), command approval (`src/lib/command-approval.ts`), config validation (`src/lib/config-validator.ts`) — all behind `containerConfig` flags
- Learning loop: `src/lib/flush-prompt.ts` (`buildFlushPrompt()`), `src/lib/skill-manager.ts` (`getExtractedSkills()`), `container/skills/learning-loop/SKILL.md` — enabled via `containerConfig.learningLoop`
