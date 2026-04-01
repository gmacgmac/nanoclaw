# Agent Team Patterns

How to coordinate multiple agents in NanoClaw — both within a single container and across groups.

---

## Terminology

| Term | Meaning |
|------|---------|
| **Group** | A registered chat configuration (one row in `registered_groups` table, keyed by JID). One JID = one group. |
| **Container** | Isolated Docker environment where an agent runs. One container per group at a time. |
| **Agent** | An AI assistant with its own memory, session, and personality. Implemented as a group/container pair. |
| **Trigger** | A pattern like `@andy` that activates a specific group when a message starts with it. |

---

## Coordination Levels

| Level | Scope | Mechanism | Status |
|-------|-------|-----------|--------|
| **Container** | Within one container | Agent SDK subagent spawning | Partial (solo works, team broken) |
| **Cross-Group** | Between containers | IPC tools (`send_message`, `schedule_task`) | ✅ One-way works, two-way not implemented |

---

## Level 1: Container-Level Agents (SDK Agent Tool)

The Agent SDK supports two patterns for spawning subagents **within a single container**:

| Pattern | Behavior | Use Case | Status |
|---------|----------|----------|--------|
| **Solo Agent** | Executes initial prompt immediately | Independent tasks, parallel work | ✅ Works |
| **Team Agent** | Waits for mailbox messages | Dynamic coordination | ❌ Broken in SDK mode |

---

### Pattern 1: Solo Agents

Each agent is spawned independently and executes its initial prompt immediately.

```
Lead Agent
├── Spawn Agent A with task in prompt → Agent A executes → Returns result
├── Spawn Agent B with task in prompt → Agent B executes → Returns result
└── Spawn Agent C with task in prompt → Agent C executes → Returns result
```

- Agents run in parallel (if spawned concurrently)
- Each agent has its own context
- Results return to lead agent
- No inter-agent communication

#### When to Use

- Independent tasks that don't require coordination
- Parallel execution is beneficial
- Each agent's task is known upfront

#### Example Prompt for Lead Agent

```
Spawn 3 independent agents to work in parallel:

1. Use the Agent tool to spawn a "Researcher" agent with this prompt:
   "List all files in /workspace/group/logs/ and count them.
    Use send_message with sender='Researcher' to report the count."

2. Use the Agent tool to spawn a "Writer" agent with this prompt:
   "Create /workspace/group/output.txt with the content 'Task complete'.
    Use send_message with sender='Writer' to confirm."

3. Use the Agent tool to spawn a "Verifier" agent with this prompt:
   "Read /workspace/group/output.txt and verify it exists.
    Use send_message with sender='Verifier' to report PASS or FAIL."

Do NOT use team_name - spawn them as individual agents.
```

#### Key Points

- Do NOT use `team_name` parameter
- Include the complete task in each agent's prompt
- Each agent should use `send_message` with their role name to report progress

---

### Pattern 2: Team Agents

> **⚠️ BROKEN (2026-03-29): Does not work in SDK programmatic mode.**
>
> **Root cause:** In SDK mode, the agent's execution loop exits after returning
> a `ResultMessage`. When a teammate receives a `SendMessage`, it marks the
> message `read: true` and sends an `idle_notification` heartbeat, but never
> re-enters the tool-calling loop to act on it. The agent is alive but
> "zombie" — it cannot execute.
>
> **Why it works in interactive mode:** `<teammate-message>` blocks are
> delivered between turns in interactive CLI. SDK mode has no "next turn"
> mechanism.
>
> **Additional bug (v2.1.76):** `TeamCreate` generates spawn commands that
> invoke the node binary path directly with `env` rather than `claude` from
> PATH, causing teammate processes to silently exit on spawn.
>
> **Use Pattern 1 (Solo Agents) with file-based coordination instead.**

---

### Workaround: File-Based Coordination

When solo agents need to coordinate (wait for each other's results), use file
polling instead of `SendMessage`:

```
Spawn Agent A with prompt:
  "Do task A. Write results to /tmp/agent-a-result.json.
   When done, create /tmp/agent-a.done"

Spawn Agent B with prompt:
  "Poll for /tmp/agent-a.done in a loop (check every 5s).
   When it exists, read /tmp/agent-a-result.json and do task B.
   Write results to /tmp/agent-b-result.json and create /tmp/agent-b.done"
```

Use files for dependency signaling. Use `send_message` only for completion
notifications back to the user.

---

## Sender Attribution

Both patterns support the `send_message` MCP tool with `sender` parameter:

```typescript
mcp__nanoclaw__send_message({
  text: "Found 3 results",
  sender: "Researcher"  // Appears as sender_name in database
})
```

In Telegram, this creates a dedicated bot identity for each sender name.

---

## Level 2: Cross-Group Communication (IPC)

Groups communicate via IPC tools. Each group runs in its own container with
its own session, memory, and personality.

### Current MCP Tools

| Tool | Description | Main-only? |
|------|-------------|------------|
| `send_message` | Send a one-way notification to a group | Cross-group: main-only |
| `schedule_task` | Schedule a task to run in any group | Cross-group: main-only |
| `list_tasks` | List scheduled tasks | No (scoped to own group unless main) |
| `get_registered_groups` | List all registered groups and their JIDs | No |
| `register_group` | Register a new chat/group | Yes |
| `pause_task` | Pause a scheduled task | No (scoped to own group unless main) |
| `resume_task` | Resume a paused task | No (scoped to own group unless main) |
| `cancel_task` | Cancel and delete a task | No (scoped to own group unless main) |
| `update_task` | Modify an existing task | No (scoped to own group unless main) |
| `ping` | Test tool, returns pong | No |

### What Works

**One-way messaging** via `send_message` with `target_jid`:
- Main group can send messages to any registered group
- Messages are stored in the target group's DB as bot messages (`is_bot_message: true`)
- The target group's agent does NOT wake up — these are notifications only
- Non-main groups can only send to their own chat

**Cross-group task scheduling** via `schedule_task` with `target_group_jid`:
- Main group can schedule tasks to run in any group's context
- The task runs as a full agent in the target group's container
- Fire-and-forget: results go to the target group, not back to the caller

### What Does NOT Work

**Agent-to-agent delegation with response routing:**
- No tool exists to send a prompt to another group and have that group's agent
  process it as a real message
- `send_message` stores with `is_bot_message: true`, which `getNewMessages()`
  filters out — the target agent never sees it
- `schedule_task` triggers the target agent but has no mechanism to route the
  response back to the caller
- There is no `delegate_to_group` or `respond_to_group` tool (yet)

### IPC Authorization Model

| `is_main` | Can message | Can schedule tasks in | Can modify tasks in |
|-----------|-------------|----------------------|---------------------|
| `true` | Any registered group | Any group | Any group |
| `false` | Only own chat | Only own group | Only own group |

See `docs/IPC.md` for the full IPC architecture.

---

## Data Model Constraint: One JID = One Group

`registeredGroups` is `Record<string, RegisteredGroup>` — a plain object keyed
by JID. Calling `registerGroup(jid, group)` does `registeredGroups[jid] = group`,
which means registering a second group with the same JID overwrites the first.

**You cannot have multiple agents with different triggers sharing the same chat
JID.** Each JID maps to exactly one group/agent.

---

## Quick Reference

| Pattern | Scope | Status | Notes |
|---------|-------|--------|-------|
| Solo Agent (no `team_name`) | Within container | ✅ Works | Execute prompt immediately |
| Team Agent (with `team_name`) | Within container | ❌ Broken | SDK mode bug, do not use |
| `send_message` cross-group | Between containers | ✅ One-way | Notification only, target agent does not wake |
| `schedule_task` cross-group | Between containers | ✅ Fire-and-forget | Target agent runs, no response routing |
| Agent delegation with response | Between containers | ❌ Not implemented | Planned: `delegate_to_group` + `respond_to_group` |
