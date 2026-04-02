# Multi-Agent Routing

Route messages to specialist sub-agents based on trigger patterns. A hub group
(e.g. your main Telegram chat) automatically intercepts `@agent` mentions and
delegates them to the correct sub-agent group.

---

## How It Works

```
User in Telegram: "@cherry can you check the logs?"

  → Host message loop sees @cherry
  → Matches cherry's registered trigger pattern
  → Creates a delegation (UUID + 5min TTL)
  → Stores the prompt in cherry's group DB as a user message
  → Cherry's agent wakes up, processes the task
  → Cherry calls respond_to_group(uuid, result)
  → Response is routed back into the hub group's queue
  → Hub agent (sana) sees the response as a normal message

User in Telegram: "what's the weather?"

  → No @trigger match
  → Hub agent (sana) processes normally
```

Unknown triggers get a notification: `"@ghostagent is not a registered agent."`

---

## Prerequisites

1. The hub group must have `isMain: true` (elevated IPC privileges)
2. The hub group must have `multiAgentRouter: true` (the on/off switch)
3. Sub-agent groups must be registered with their own JIDs and trigger patterns
4. The `delegations` table must exist in the DB (created automatically on schema init)

### Security constraints

- Only `isMain` groups can delegate to other groups. This is enforced at both
  the MCP tool level (container) and the IPC handler level (host). Non-main
  groups cannot inject prompts into other groups.
- `multiAgentRouter` is ignored if the group does not have `isMain: true`.
- Sub-agents can respond to delegations (via `respond_to_group`) but cannot
  initiate delegations themselves.
- To disable multi-agent routing, set `multiAgentRouter: false` (or remove it)
  on the hub group. The hub agent will process all messages itself again.

---

## Setup

### 1. Enable the router on the hub group

Set `multiAgentRouter: true` on the hub group's registration. The flag is
persisted in the `multi_agent_router` column of the `registered_groups` table.

**First time only**: restart NanoClaw after deploying the code so the DB
migration creates the `multi_agent_router` column and the `delegations` table.

Enable via SQL:

```sql
UPDATE registered_groups SET multi_agent_router = 1 WHERE folder = 'telegram_main';
```

Verify:

```sql
SELECT jid, name, folder, is_main, multi_agent_router FROM registered_groups;
```

No restart needed after flipping the flag — it's read from the DB on each
message loop iteration.

### 2. Register sub-agent groups

Each sub-agent needs its own group registration with a unique JID and trigger:

```
mcp__nanoclaw__register_group({
  jid: "cherry@internal",
  name: "Cherry",
  folder: "cherry",
  trigger: "@cherry"
})
```

Internal JIDs (like `cherry@internal`) work fine — the delegation mechanism
uses the DB and queue, not external channels.

### 3. Create sub-agent group folders

```bash
mkdir -p ~/.nanoclaw/groups/cherry
```

Create a `CLAUDE.md` in each sub-agent folder with:
- The agent's personality and instructions
- Instructions to call `respond_to_group` with the delegation UUID when done
- Instructions to use `send_message` with `target_jid` for direct notifications

### 4. Sub-agent CLAUDE.md template

```markdown
# Cherry

You are Cherry, a specialist agent for [domain].

## Delegation Protocol

When you receive a message containing `[Delegation UUID: ...]`, you are being
asked to complete a task by another agent. When you finish:

1. Call `mcp__nanoclaw__respond_to_group` with:
   - `uuid`: the UUID from the delegation message
   - `response_text`: your result

2. If you also want to notify the user directly in Telegram, use
   `mcp__nanoclaw__send_message` with `target_jid` set to the hub group's JID.

## Formatting

This agent's responses are routed back to Telegram.
Consult the `telegram-formatting` skill for formatting rules.
```

---

## Configuration Reference

### RegisteredGroup fields

| Field | Type | Description |
|-------|------|-------------|
| `requiresTrigger` | `boolean` | `true`: only respond to own trigger. `false`: respond to all messages. |
| `multiAgentRouter` | `boolean` | `true`: scan messages for other groups' triggers and auto-delegate. Only works with `isMain: true`. |
| `isMain` | `boolean` | Elevated IPC privileges. Required for `multiAgentRouter`. |

### Three modes

| `requiresTrigger` | `multiAgentRouter` | Behaviour |
|---|---|---|
| `true` | `false` | Standard. Only responds to own trigger. |
| `false` | `false` | Chatty. Responds to everything. No routing. |
| `false` | `true` | Hub. Responds to everything, but intercepts other agents' triggers and delegates. |

---

## MCP Tools

### delegate_to_group

Explicitly delegate a task to another group. Main-only.

```
mcp__nanoclaw__delegate_to_group({
  target_jid: "cherry@internal",
  prompt: "Check the server logs for errors in the last hour",
  ttl_seconds: 300
})
```

Returns the UUID for correlation.

### respond_to_group

Respond to a delegation. Any group can call this.

```
mcp__nanoclaw__respond_to_group({
  uuid: "abc123-...",
  response_text: "Found 3 errors in the last hour: ..."
})
```

The response is stored in the caller's group DB and the caller's agent wakes up.

### Existing tools that complement routing

| Tool | Use case in multi-agent context |
|------|------|
| `send_message` with `target_jid` | Sub-agent sends a notification directly to the hub chat |
| `get_registered_groups` | Discover available sub-agents and their JIDs |
| `schedule_task` with `target_group_jid` | Schedule recurring work in a sub-agent's context |

---

## How delegation works internally

1. Hub's message loop matches `@cherry` against registered triggers
2. Creates a `delegations` table row: `{ uuid, caller_jid, target_jid, expires_at, status: 'pending' }`
3. Stores the prompt (with trigger stripped) as a user message in cherry's DB (`is_bot_message: false`)
4. Calls `enqueueMessageCheck` on cherry's JID — cherry's agent wakes up
5. Cherry processes the message, calls `respond_to_group(uuid, result)`
6. Host validates UUID (exists, pending, not expired, correct responder)
7. Stores response in hub's DB as a user message, calls `enqueueMessageCheck` on hub's JID
8. Hub agent sees the response as a normal message in its queue

UUID expiry is checked at response time — no background timers. Default TTL is 5 minutes.

---

## Troubleshooting

### Enabling and disabling

To enable:

```sql
UPDATE registered_groups SET multi_agent_router = 1 WHERE folder = 'telegram_main';
```

To disable:

```sql
UPDATE registered_groups SET multi_agent_router = 0 WHERE folder = 'telegram_main';
```

The hub agent goes back to processing all messages itself. Existing sub-agent
registrations are unaffected — they just won't receive auto-delegated messages.

No restart required after changing the flag. However, the first deployment
requires a restart to run the DB migration that adds the column.

### Sub-agent never wakes up

- Check the sub-agent's group is registered: `get_registered_groups`
- Check the trigger pattern matches: triggers are case-insensitive, matched at start of message
- Check `multiAgentRouter: true` is set on the hub group
- Check the hub group has `isMain: true`

### Response never arrives back at hub

- Check the sub-agent called `respond_to_group` with the correct UUID
- Check the delegation hasn't expired (default 5 min TTL)
- Check logs for `Delegation expired` or `wrong responder` warnings

### Unknown trigger notification is annoying

The `"@X is not a registered agent"` message fires for any `@mention` at the
start of a message that doesn't match a registered trigger. If this is too
aggressive, the check can be disabled by removing the `multiAgentRouter` flag.
