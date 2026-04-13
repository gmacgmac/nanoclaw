# Delegation Setup

Configuration guide for multi-agent routing and delegation in NanoClaw.

For conceptual overview of the two delegation patterns (auto-routed dispatch vs
orchestrated delegation), see [agent-team-patterns.md](agent-team-patterns.md)
"Group Delegation" section.

---

## Prerequisites

1. Hub group must have `isMain: true` (elevated IPC privileges)
2. Hub group must have `multiAgentRouter: true` to enable auto-routing
3. Sub-agent groups must be registered with their own JIDs and trigger patterns
4. Sub-agents using `send_message(target_jid)` must have `isMain: true`
5. `delegations` table must exist in the DB (created automatically on schema init)

### Security constraints

- Only `isMain` groups can delegate to other groups
- `multiAgentRouter` is ignored if the group does not have `isMain: true`
- Sub-agents can respond to delegations (via `respond_to_group`) but cannot initiate delegations
- `send_message(target_jid)` requires `isMain: true` — non-main groups can only send to their own chat

---

## Setup

### 1. Enable the router on the hub group

Set `multiAgentRouter: true` on the hub group's registration:

```sql
UPDATE registered_groups SET multi_agent_router = 1 WHERE folder = 'telegram_main';
```

Verify:

```sql
SELECT jid, name, folder, is_main, multi_agent_router FROM registered_groups;
```

No restart needed if you use the `register_group` MCP tool (it updates both DB and in-memory state). If you use raw SQL instead, restart NanoClaw for the change to take effect.

**First time only**: restart NanoClaw after deploying the code so the DB migration creates the `multi_agent_router` column and the `delegations` table.

### 2. Register sub-agent groups

Each sub-agent needs its own group registration with a unique JID and trigger:

```sql
-- For Flow 1 (auto-routed dispatch, sub-agent responds directly to user)
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, requires_trigger, multi_agent_router)
VALUES ('dashboard@internal', 'Dashboard', 'dashboard', '@dashboard', datetime('now'), 1, 1, 0);

-- For Flow 2 (orchestrated delegation, sub-agent responds via respond_to_group)
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, requires_trigger, multi_agent_router)
VALUES ('fin@internal', 'Fin', 'fin', '@fin', datetime('now'), 0, 1, 0);
```

**Key difference**: Flow 1 sub-agents need `is_main=1` to use `send_message(target_jid)`. Flow 2 sub-agents can have `is_main=0` since they use `respond_to_group`.

### 3. Create sub-agent group folders

```bash
mkdir -p ~/.nanoclaw/groups/dashboard
mkdir -p ~/.nanoclaw/groups/fin
```

Create a `CLAUDE.md` in each sub-agent folder. See templates below.

### 4. Create chats table row for internal groups

Internal groups require a row in the `chats` table:

```sql
INSERT INTO chats (jid, name, last_message_time, channel, is_group)
VALUES ('dashboard@internal', 'Dashboard', datetime('now'), 'dashboard', 0);
```

Without this row, messages queued for the internal group will not be processed.

### 5. Sub-agent CLAUDE.md templates

**Flow 1 (auto-routed dispatch) — responds directly to user:**

```markdown
# Dashboard

You are Dashboard, a specialist agent for monitoring.

## Responding to Routed Messages

When you receive a message containing `[Routed from ...]`, respond directly
to the user using:

```
mcp__nanoclaw__send_message with target_jid: "<caller JID from message>"
```

For example, if the message says:
`[Routed from GM. Reply using send_message with target_jid: "tg:6013943815"]`

Call `send_message` with `target_jid: "tg:6013943815"` and your response text.

## Purpose

{Describe the agent's purpose and capabilities}
```

**Flow 2 (orchestrated delegation) — responds back to hub:**

```markdown
# Fin

You are Fin, a specialist agent for financial analysis.

## Delegation Protocol

When you receive a message containing `[Delegation UUID: ...]`, you are being
asked to complete a task by another agent. When you finish:

1. Call `mcp__nanoclaw__respond_to_group` with:
   - `uuid`: the UUID from the delegation message
   - `response_text`: your result

Note: Flow 2 sub-agents have `is_main=0`, so `send_message` always sends to
your own chat. Use `respond_to_group` to route results back to the caller.

## Purpose

{Describe the agent's purpose and capabilities}
```

---

## Configuration Reference

### RegisteredGroup fields

| Field | Type | Description |
|-------|------|-------------|
| `is_main` | `boolean` | Elevated IPC privileges. Required for hub groups and for sub-agents that use `send_message(target_jid)`. |
| `requires_trigger` | `boolean` | `true`: only respond when @mentioned. `false`: respond to all messages. |
| `multi_agent_router` | `boolean` | `true`: scan messages for other groups' triggers and auto-route. Only effective with `isMain: true` on hub. |

### Group mode combinations

| `is_main` | `requires_trigger` | `multi_agent_router` | Role |
|-----------|-------------------|---------------------|------|
| 1 | 0 | 1 | Hub — processes everything, routes @mentions to sub-agents |
| 1 | 1 | 0 | Flow 1 sub-agent — responds directly to user via `send_message(target_jid)` |
| 0 | 1 | 0 | Flow 2 sub-agent — responds via `respond_to_group` back to hub |

---

## MCP Tools

### delegate_to_group

Explicitly delegate a task to another group. Main-only.

```
mcp__nanoclaw__delegate_to_group({
  target_jid: "fin@internal",
  prompt: "Check the server logs for errors",
  ttl_seconds: 300
})
```

Returns the UUID for correlation. `ttl_seconds` is clamped to 30–3600 (default 300).

### respond_to_group

Respond to a delegation. Only the designated target group can call this (validated by UUID + caller identity).

```
mcp__nanoclaw__respond_to_group({
  uuid: "abc123-...",
  response_text: "Found 3 errors in the last hour: ..."
})
```

The response is stored in the caller's group DB and wakes up the caller's agent.

### send_message with target_jid

Send a message directly to another group's chat. Main-only.

```
mcp__nanoclaw__send_message({
  text: "Task complete",
  target_jid: "tg:6013943815"
})
```

Used by Flow 1 sub-agents to respond directly to the user.

### get_registered_groups

List all registered groups and their JIDs. Any group can call this.

---

## Troubleshooting

### Sub-agent never wakes up

- Check the sub-agent's group is registered: `SELECT * FROM registered_groups WHERE folder = 'dashboard'`
- Check the trigger pattern matches: triggers are case-insensitive, matched at start of message
- Check `multiAgentRouter: true` is set on the hub group
- Check the hub group has `isMain: true`
- For internal groups, check the `chats` table has a row for the JID

### Sub-agent can't send to target_jid

- Sub-agent needs `is_main:1` to use `send_message(target_jid)`
- Without `is_main`, the tool ignores `target_jid` and sends to own chat

### Response never arrives back at hub

- Check the sub-agent called `respond_to_group` with the correct UUID
- Check the delegation hasn't expired (default 5 min TTL)
- Check logs for `Delegation expired` or `wrong responder` warnings

### Unknown trigger notification is annoying

The `"@X is not a registered agent"` message fires for any `@mention` at the
start of a message that doesn't match a registered trigger. Disable by removing
the `multiAgentRouter` flag:

```sql
UPDATE registered_groups SET multi_agent_router = 0 WHERE folder = 'telegram_main';
```

### Internal group not receiving messages

Check the `chats` table has a row for the internal group's JID:

```sql
SELECT * FROM chats WHERE jid = 'dashboard@internal';
```

If empty, create it:

```sql
INSERT INTO chats (jid, name, last_message_time, channel, is_group)
VALUES ('dashboard@internal', 'Dashboard', datetime('now'), 'dashboard', 0);
```