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
| **Cross-Group** | Between containers | IPC tools (`send_message`, `delegate_to_group`, `respond_to_group`, `schedule_task`) | ✅ One-way + delegation with response routing |

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
| `send_message` | Send a message to the user or group immediately | Cross-group: main-only |
| `delegate_to_group` | Delegate a task to another group's agent with UUID correlation | Yes |
| `respond_to_group` | Respond to a pending delegation (validates UUID, caller identity) | No |
| `schedule_task` | Schedule a recurring or one-time task in any group | Cross-group: main-only |
| `list_tasks` | List scheduled tasks | No (scoped to own group unless main) |
| `get_registered_groups` | List all registered groups and their JIDs | No |
| `register_group` | Register a new chat/group | Yes |
| `pause_task` | Pause a scheduled task | No (scoped to own group unless main) |
| `resume_task` | Resume a paused task | No (scoped to own group unless main) |
| `cancel_task` | Cancel and delete a task | No (scoped to own group unless main) |
| `update_task` | Modify an existing task | No (scoped to own group unless main) |
| `manual_flush` | Trigger memory compaction mid-session | No |
| `execute_command` | Execute a shell command (with approval mode for write-mounted paths) | No |
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

### Delegation with Response Routing

**`delegate_to_group` + `respond_to_group`** enable full request/response delegation:
- Main group calls `delegate_to_group(target_jid, prompt, ttl_seconds)` → creates a UUID record in the `delegations` table
- Host injects the prompt as a user message in the target group's DB (`is_bot_message: false`) and wakes the target agent
- Target agent processes the task and calls `respond_to_group(uuid, response_text)`
- Host validates the UUID (exists, not expired, not already fulfilled, caller is the correct target), marks it fulfilled, and stores the response in the caller's message queue
- Caller agent wakes up and sees the response as a `[Delegation Response — UUID: ...]` message

See the [Group Delegation](#group-delegation) section below for Flow 1 (auto-routed) and Flow 2 (orchestrated) patterns.

**Note:** `send_message` is one-way only — it stores with `is_bot_message: true`, which `getNewMessages()` filters out. The target agent never sees it. Use `delegate_to_group` when you need the target agent to process a task and respond.

### IPC Authorization Model

| `is_main` | Can message | Can schedule tasks in | Can modify tasks in |
|-----------|-------------|----------------------|---------------------|
| `true` | Any registered group | Any group | Any group |
| `false` | Only own chat | Only own group | Only own group |

See `docs/ipc.md` for the full IPC architecture.

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
| `delegate_to_group` + `respond_to_group` | Between containers | ✅ Works | Full request/response delegation with UUID correlation |




---

# Group Delegation

> **Setup instructions**: See [delegation-setup.md](delegation-setup.md) for SQL commands,
> CLAUDE.md templates, and troubleshooting.

**Flow 1: Auto-Routed Dispatch (host intercepts, hub never sees it)**

- User sends `@dashboard check the error logs` in Telegram
- Host message loop picks up the message for telegram_main's JID
- Host checks `multiAgentRouter: true` on telegram_main
- Host scans message against all registered group triggers
- `@dashboard` matches the dashboard group's trigger
- Host stores the prompt (with trigger stripped) as a user message in dashboard's DB (`is_bot_message: false`)
- Host calls `enqueueMessageCheck` on dashboard's JID — dashboard agent wakes up
- Hub (telegram_main) never sees this message — it was intercepted before reaching her
- Dashboard agent processes the task
- Dashboard agent calls `send_message(target_jid: "tg:YOUR_CHAT_ID", text: "Here are the errors...")` to notify the user directly in Telegram
- User sees the response in Telegram from the dashboard bot identity

**DB config for Flow 1:**

```sql
-- Hub group: multiAgentRouter enabled, isMain
UPDATE registered_groups SET multi_agent_router = 1 WHERE folder = 'telegram_main';

-- Sub-agent: own JID, own trigger, MUST have is_main=1 to use send_message(target_jid)
-- requires_trigger=1 means it only responds when @mentioned
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, requires_trigger, multi_agent_router)
VALUES ('dashboard@internal', 'Dashboard', 'dashboard', '@dashboard', datetime('now'), 1, 1, 0);
```

**Why `is_main=1` for sub-agents in Flow 1:**

The `send_message` MCP tool only allows `target_jid` for main groups:
```typescript
const targetJid = isMain && args.target_jid ? args.target_jid : chatJid;
```
Without `is_main=1`, the sub-agent can only send to its own chat. `requires_trigger=1` ensures the sub-agent still only responds when @mentioned.

---

**Flow 2: Orchestrated Delegation (hub receives, delegates, synthesizes, responds)**

- User sends `sana, get fin to check the portfolio and cherry to review the logs` in Telegram
- No `@trigger` at the start of the message — host doesn't intercept
- Message falls through to hub (telegram_main) as normal
- Hub's agent wakes up, reads the message
- Hub calls `delegate_to_group(target_jid: "fin@internal", prompt: "Check the portfolio", ttl_seconds: 300)`
- Hub calls `delegate_to_group(target_jid: "cherry@internal", prompt: "Review the logs", ttl_seconds: 300)`
- Both delegations create UUID records in the `delegations` table
- Both prompts are stored as user messages in fin's and cherry's DBs
- Both agents wake up and process their tasks
- Fin calls `respond_to_group(uuid_1, "Portfolio looks healthy, up 3%...")`
- Cherry calls `respond_to_group(uuid_2, "Found 2 warnings in the logs...")`
- Host validates each UUID, stores each response in telegram_main's DB as a user message
- Host calls `enqueueMessageCheck` on telegram_main's JID each time
- Hub wakes up, sees `[Delegation Response — UUID: ...]` messages in her queue
- Hub synthesizes: "Fin says portfolio is up 3%. Cherry found 2 log warnings. Here's the summary..."
- User sees hub's synthesized response in Telegram

**DB config for Flow 2:**

```sql
-- Hub group: isMain (already set), multiAgentRouter can be on or off for this flow
-- (delegate_to_group is an explicit MCP tool call, doesn't need the router flag)

-- Sub-agents: own JIDs, own triggers, is_main=0 (they respond via respond_to_group, not send_message)
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, multi_agent_router)
VALUES ('fin@internal', 'Fin', 'fin', '@fin', datetime('now'), 0, 0);

INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, multi_agent_router)
VALUES ('cherry@internal', 'Cherry', 'cherry', '@cherry', datetime('now'), 0, 0);
```

---

**Comparison:**

| Aspect | Flow 1 (Auto-Routed) | Flow 2 (Orchestrated) |
|--------|----------------------|------------------------|
| Trigger | `@subagent` at message start | Explicit `delegate_to_group()` call |
| Hub sees message? | No (intercepted) | Yes |
| Sub-agent responds via | `send_message(target_jid)` | `respond_to_group(uuid)` |
| Sub-agent `is_main` | **Must be 1** | Can be 0 |
| Hub synthesizes? | No | Yes |
| `multiAgentRouter` required | Yes (on hub) | No |

Both can coexist — if `multiAgentRouter: true` is set, `@fin check X` goes directly to fin (Flow 1), but "sana, get fin to check X" goes to sana who then delegates (Flow 2).