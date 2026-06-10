---
name: add-internal-group
description: Add an internal group (no external channel) to NanoClaw. Creates a group that responds via dashboard-style polling or delegation, without Telegram/WhatsApp/etc.
---

# Add Internal Group

This skill adds a new internal group to NanoClaw. Internal groups use the `*@internal` JID pattern and don't require an external messaging platform. They're useful for:

- Dashboard-style UI groups (poll DB for messages)
- Delegation targets (sub-agents that handle specialized tasks)
- API-triggered workflows
- Scheduled task handlers

The dashboard channel (`src/channels/dashboard.ts`) already handles all `*@internal` JIDs, so no channel code changes are needed — just registration.

## Phase 1: Ask for Configuration

Use `AskUserQuestion` to collect:

1. **Group name** — Display name (e.g., "Research", "Notes", "Scheduler")
2. **Folder name** — Lowercase, no spaces (e.g., "research", "notes", "scheduler")
3. **Trigger pattern** — What triggers this agent (e.g., "@research", "@notes")
4. **Main group?** — Whether this group responds to all messages without requiring a trigger

Ask one question at a time or use a multi-question prompt:

```
AskUserQuestion: I'll create an internal group for you. Please provide:

1. Group name (display name, e.g., "Research Agent"): 
2. Folder name (lowercase, no spaces, e.g., "research"):
3. Trigger pattern (e.g., "@research"):
4. Is this a main group? (responds to all messages without trigger): yes/no
```

## Phase 2: Validate Inputs

### Folder name validation

Must be a valid folder name:
- Lowercase letters, numbers, hyphens, underscores only
- No spaces
- Must not already exist in `groups/` directory

```bash
ls groups/
```

If folder exists, ask for a different name.

### Trigger pattern validation

If not a main group, trigger pattern should:
- Start with `@` (e.g., `@research`)
- Not conflict with existing groups:

> Set `API_TOKEN` if auth is enabled: `export API_TOKEN=$(grep API_TOKEN .env | cut -d= -f2)`

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups | jq '.data[] | {jid, name, trigger}'
```

## Phase 3: Register the Group

### Determine JID

The JID format for internal groups is `{folder}@internal`:

- `research@internal`
- `notes@internal`
- `scheduler@internal`

### Run registration

Use the setup script:

```bash
npx tsx setup/index.ts register -- \
  --jid "{folder}@internal" \
  --name "{name}" \
  --folder "{folder}" \
  --trigger "{trigger}" \
  --channel dashboard \
  --endpoint <provider> \
  [--no-trigger-required] \
  [--is-main]
```

Flags:
- `--endpoint` — **required**. Vendor prefix from `secrets.env` (e.g. `ollama`, `anthropic`, `zai`)
- `--no-trigger-required` — use if main group (responds to all messages)
- `--is-main` — use if this is the primary group (there can only be one main group per JID)

Example for a delegation-only sub-agent:

```bash
npx tsx setup/index.ts register -- \
  --jid "research@internal" \
  --name "Research" \
  --folder "research" \
  --trigger "@research" \
  --channel dashboard \
  --endpoint ollama
```

Example for a main-style group:

```bash
npx tsx setup/index.ts register -- \
  --jid "assistant@internal" \
  --name "Assistant" \
  --folder "assistant" \
  --trigger "@assistant" \
  --channel dashboard \
  --endpoint ollama \
  --no-trigger-required \
  --is-main
```

## Phase 4: Create Chats Table Row

**CRITICAL:** Internal groups require a row in the `chats` table for message processing. The foreign key constraint in `messages` table requires a valid chat_jid reference.

```bash
curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"jid\":\"{folder}@internal\",\"name\":\"{name}\",\"channel\":\"dashboard\",\"isGroup\":false}" \
  http://localhost:3100/api/chats
```

Example:
```bash
curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"jid":"research@internal","name":"Research","channel":"dashboard","isGroup":false}' \
  http://localhost:3100/api/chats
```

**Without this row, messages queued for the internal group will not be processed.**

## Phase 5: Create Group CLAUDE.md

Create `groups/{folder}/CLAUDE.md` with appropriate content based on the group's purpose.

### Template for delegation target (sub-agent)

```markdown
# {Name}

You are {Name}, a specialist agent for {purpose}.

## Delegation Protocol

When you receive a message containing `[Delegation UUID: ...]`, you are being
asked to complete a task by another agent. When you finish:

1. Call `mcp__nanoclaw__respond_to_group` with:
   - `uuid`: the UUID from the delegation message
   - `response_text`: your result

2. If you also want to notify the user directly, use
   `mcp__nanoclaw__send_message` with `target_jid` set to the hub group's JID.

## Purpose

{Describe the agent's purpose and capabilities here}
```

### Template for main-style group

```markdown
# {Name}

You are {Name}, an assistant for {purpose}.

## Behavior

{Describe how the agent should behave}

## Context

This group receives messages directly (no trigger required). Respond naturally
to each message.
```

### For dashboard UI polling

If this group will be used with a dashboard UI:

```markdown
## Formatting

This agent's responses are stored in the database for UI polling.
Use clear formatting with markdown.
```

## Phase 6: Configure container settings

Run `/configure-group <folder>` to set the group's container configuration:

- Allowed tools (e.g. exclude `WebSearch`/`WebFetch` if desired)
- Model and endpoint
- Host commands (e.g. enable `/model` for preset switching)
- Security settings (SSRF, injection scanning, approval mode)
- Additional mounts and MCP servers
- Personality (system prompt, timeout)

> **Note:** Approval mode is on by default — dangerous commands on write-mounted paths require confirmation. You'll be asked in `/configure-group` whether to disable it.

See the `/configure-group` skill for full details.

## Phase 7: Restart Service

**Restart is NOT required** if the service is already running. The message loop will pick up new internal groups on the next cycle. Only restart if you want to force immediate processing.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 8: Verify

Check registration:

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups \
  | jq '.data[] | select(.jid | endswith("@internal")) | {jid, name, folder, trigger, isMain}'
```

Test by delegating from another group:

```
@{trigger} hello, can you help me with something?
```

Or via IPC (for dashboard-style):

```bash
echo '{"type":"message","chatJid":"{folder}@internal","text":"test message"}' > data/ipc/{folder}/messages/test.json
```

## Multi-Agent Routing

If this internal group should be reachable via `@mention` from another group (e.g., main Telegram group), ensure:

1. The trigger pattern is unique across all groups
2. The calling group's `multi_agent_router` is enabled:

```bash
curl -sS -X PATCH -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"multiAgentRouter": true}' \
  http://localhost:3100/api/groups/tg:telegram_main
```

3. The delegation flow works:
   - User sends `@research analyze this` in Telegram
   - Host detects trigger, creates delegation to `research@internal`
   - Research agent processes, calls `respond_to_group`
   - Response routed back to Telegram

## Troubleshooting

### Group not responding at all (no container launch)

**Most common cause:** Missing row in `chats` table. The `messages` table has a foreign key constraint to `chats`. Without this row, messages cannot be queued.

Check:
```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/chats/{folder}@internal | jq .
```

If empty, create it:
```bash
curl -sS -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"jid\":\"{folder}@internal\",\"name\":\"{name}\",\"channel\":\"dashboard\",\"isGroup\":false}" \
  http://localhost:3100/api/chats
```

### Group not responding to delegation

1. Check group is registered:
   ```bash
   curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups/{folder}@internal | jq .
   ```
2. Check logs: `tail -f logs/nanoclaw.log`
3. Verify trigger pattern matches what you're sending

### Group folder not created

```bash
mkdir -p groups/{folder}/logs
```

### Need to clear history

See "To clear chat history for a group" in CLAUDE.md. For internal groups:

```bash
GROUP="{folder}"
JID="{folder}@internal"

curl -sS -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3100/api/sessions/$GROUP
curl -sS -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:3100/api/chats/$JID/messages?confirm=true"
rm -rf data/sessions/$GROUP/.claude/projects/
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Removal

To remove an internal group:

```bash
# Remove the group registration
curl -sS -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3100/api/groups/{folder}@internal
# Clear session
curl -sS -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3100/api/sessions/{folder}
# Clear message history
curl -sS -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:3100/api/chats/{folder}@internal/messages?confirm=true"
rm -rf groups/{folder}
rm -rf data/sessions/{folder}
```

No channel code changes needed — the dashboard channel handles all `*@internal` JIDs.