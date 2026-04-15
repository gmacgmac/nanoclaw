# NanoClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your Mac.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-telegram` - Replace WhatsApp with Telegram entirely

### Container Runtime
The project uses Docker by default (cross-platform). For macOS users who prefer Apple Container:
- `/convert-to-apple-container` - Switch from Docker to Apple Container (macOS-only)

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal Claude assistant accessible via messaging channels (Telegram, WhatsApp, Slack, etc.), with minimal custom code.

**Core components:**
- **Claude Agent SDK** as the core agent
- **Docker containers** for isolated agent execution
- **Messaging channels** as skills that self-register at startup (Telegram, WhatsApp, Slack, Discord, Gmail)
- **Dashboard** as an internal web UI channel
- **Persistent memory** per group (MEMORY.md, COMPACT.md, session transcripts)
- **Scheduled tasks** that run Claude and can message back
- **Web access** for search and browsing (built-in or via MCP proxy for non-Anthropic endpoints)
- **Browser automation** via agent-browser (host-stored binary, mounted at runtime)
- **Multi-agent delegation** for orchestrating sub-agents across groups

**Implementation approach:**
- Use existing tools (Claude Agent SDK, MCP servers, channel-specific libraries)
- Minimal glue code — single Node.js orchestrator
- File-based systems where possible (CLAUDE.md for instructions, memory/ for persistence, folders for groups)
- Credentials never reach containers — host-side proxy injects them at request time

---

## Architecture Decisions

### Message Routing
- A router listens to messaging channels (Telegram, Dashboard, etc.) and routes messages based on configuration
- Channels are skills that self-register at startup — WhatsApp, Telegram, Slack, Discord, Gmail are all separate skills
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable per-group via the `trigger` column in `registered_groups`
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md` and a `memory/` directory
- **Four memory layers**: Session transcript (`.jsonl`), `MEMORY.md` (durable facts), `COMPACT.md` (session summary), and `CLAUDE.md` (instructions/personality)
- `MEMORY.md` and `COMPACT.md` are loaded via `@import` directives in CLAUDE.md — the SDK expands them at container spawn time
- There is no global CLAUDE.md loaded at runtime — `groups/global/CLAUDE.md` exists as a template for new groups
- Agent runs in the group's folder at `/workspace/group`, loading only that group's CLAUDE.md

### Session Management
- Each group maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Container Isolation
- All agents run inside Docker containers
- Each group gets its own folder at `/workspace/group` (read-write) — no implicit project root or global folder mounts
- Extra filesystem paths are exposed via `containerConfig.additionalMounts`
- Containers provide filesystem isolation — agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser binary (host-stored, mounted at runtime when the skill is enabled)
- Containers are NOT one-per-message: they stay alive via IPC polling, idle-timeout after 30 min

### Scheduled Tasks
- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks
- A separate nightly maintenance cron flushes groups above 50% context usage

### Group Management
- New groups are registered via `register_group` MCP tool or the `/add-internal-group` skill
- Groups are registered in SQLite (`registered_groups` table)
- Each group gets a dedicated folder under `groups/`
- `register_group` does NOT create `CLAUDE.md` or `memory/` — these must be created manually using the global/main template
- Groups can have additional directories mounted via `containerConfig.additionalMounts` (validated against `~/.config/nanoclaw/mount-allowlist.json`)

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can use `delegate_to_group` MCP tool to dispatch work to sub-agents
- Can configure additional directory mounts for any group

---

## Integration Points

### Messaging Channels
- Channels are skills that self-register at startup via the channel registry (`src/channels/registry.ts`)
- Supported channels: Telegram, WhatsApp, Slack, Discord, Gmail, Dashboard (internal)
- Each channel is a separate skill — install via feature skills (e.g. `/add-telegram`, `/add-slack`)
- Messages stored in SQLite, polled by the message loop

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `nanoclaw` MCP server (inside container) provides IPC tools: `delegate_to_group`, `respond_to_group`, `manual_flush`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Claude Agent SDK in containerized group context
- Nightly maintenance cron flushes groups above 50% context usage

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation
- agent-browser binary stored on host at `container/binaries/agent-browser/` (MUST be committed to git)
- Mounted into containers only when `agent-browser` is in the group's `skills` list
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Claude Code
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, authenticate channels, configure scheduler, start services
- `/customize` - General-purpose skill for adding capabilities (new channels, integrations, behavior changes)
- `/update-nanoclaw` - Pull upstream changes, merge with customizations, run migrations
- `/debug` - Container issues, logs, troubleshooting

### Deployment
- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**NanoClaw** - A reference to Clawdbot (now OpenClaw).
