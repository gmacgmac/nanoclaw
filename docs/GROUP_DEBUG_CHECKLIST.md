# Group Debug Checklist

Troubleshooting guide for group-specific issues in NanoClaw.

---

## Session Reset

When a group's container fails to start or shows session errors, the session may be corrupted.

### Symptoms

- Container exits immediately with code 1
- Error: "No conversation found with session ID: {uuid}"
- Container logs show session ID but no matching `.jsonl` file

### What Makes Up a Session

| Component | Location |
|-----------|----------|
| Session ID | SQLite `sessions` table (`group_folder` → `session_id`) |
| Transcript file | `data/sessions/{group}/.claude/projects/-workspace-group/{session-id}.jsonl` |
| In-memory cache | `sessions` object in running host process |

### What Breaks

| Scenario | Result |
|----------|--------|
| `.jsonl` deleted, session ID remains | "No conversation found" error |
| Session ID in SQLite, file missing | Container fails, ID re-saved on error |
| SQLite cleared, in-memory cache persists | Stale ID keeps being used |

### Correct Way to Reset a Session

Use this when the session is corrupted but you want to **keep message history**:

```bash
# 1. Stop the host (clears in-memory cache)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
# On Linux: systemctl --user stop nanoclaw

# 2. Delete session entry from SQLite
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{group}'"

# 3. Delete transcript files
rm -rf data/sessions/{group}/.claude/projects/

# 4. Restart host
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# On Linux: systemctl --user start nanoclaw
```

### Clear Chat History (Fresh Start)

Use this when you want to **completely reset** a group — no conversation memory:

```bash
GROUP="telegram_main"
JID="tg:6013943815"  # The chat_jid for this group

# 1. Stop the host (clears in-memory cache)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 2. Delete session entry from SQLite
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '$GROUP'"

# 3. Delete transcript files (agent's conversation context)
rm -rf data/sessions/$GROUP/.claude/projects/

# 4. Delete message history (incoming + outgoing)
sqlite3 store/messages.db "DELETE FROM messages WHERE chat_jid = '$JID'"

# 5. Restart host
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**What gets cleared:**
| Step | What it clears | Why |
|------|----------------|-----|
| Session row | SDK's session ID → transcript mapping | Prevents "No conversation found" error |
| JSONL files | Agent's full conversation context | Thinking, tool calls, responses — the agent's memory |
| DB messages | `messages` table for this chat | Incoming user messages + outgoing bot messages |

### Dashboard Group Specific

For `dashboard@internal`, the same process applies. Use:

```bash
GROUP="dashboard"
JID="dashboard@internal"

# Follow the "Clear Chat History" steps above
# Then optionally clear test files:
rm -f groups/dashboard/hello.txt
rm -f groups/dashboard/results.txt
```

---

## Container Won't Start

### Check Container Logs

```bash
# Latest log for the group
cat groups/{group}/logs/$(ls -t groups/{group}/logs/ | head -1)
```

### Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| "No conversation found" | Missing `.jsonl` file | Reset session (above) |
| "Permission denied" | Mount path not accessible | Check `mount-allowlist.json` |
| "Container name already in use" | Previous container stuck | `docker rm -f nanoclaw-{group}-*` |
| "Image not found" | Container not built | Run `./container/build.sh` |

### Verify Directory Structure

```bash
# Required directories
ls -la data/sessions/{group}/.claude/
ls -la groups/{group}/
ls -la data/ipc/{group}/
```

---

## Session State Inspection

### Check Session ID

```bash
sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder = '{group}'"
```

### Check Transcript File Exists

```bash
# Find the .jsonl file
find data/sessions/{group}/.claude/projects -name "*.jsonl"
```

### Check Session Directory Structure

```bash
# Expected structure
data/sessions/{group}/.claude/
├── plugins/
├── projects/
│   └── -workspace-group/
│       └── {session-id}.jsonl
├── settings.json
├── skills/
├── tasks/
└── teams/
```

---

## IPC Issues

### Messages Not Processing

```bash
# Check for pending IPC files
ls -la data/ipc/{group}/messages/
ls -la data/ipc/{group}/tasks/

# Check for error files
ls -la data/ipc/errors/
```

### Clear Stuck IPC

```bash
# Remove pending messages (will lose them)
rm -rf data/ipc/{group}/messages/*

# Move errors for review
mv data/ipc/errors/* /tmp/nanoclaw-errors/
```

---

## Quick Reference: Full Group Reset

Nuclear option - completely reset a group to fresh state:

```bash
GROUP="dashboard"          # Folder name
JID="dashboard@internal"   # Chat JID (check registered_groups table)

# Stop host
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Clear session (agent's conversation context)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '$GROUP'"
rm -rf data/sessions/$GROUP/.claude/projects/

# Clear message history (incoming + outgoing)
sqlite3 store/messages.db "DELETE FROM messages WHERE chat_jid = '$JID'"

# Clear IPC queue
rm -rf data/ipc/$GROUP/messages/*
rm -rf data/ipc/$GROUP/tasks/*

# Clear group files (optional)
rm -rf groups/$GROUP/*

# Restart host
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**To find the JID for a group:**
```bash
sqlite3 store/messages.db "SELECT jid, folder FROM registered_groups"
```

---

## Double Messages / Agent Responding to Its Own Output

### Symptoms

- Agent sends a reply, then immediately sends a second message like "Message sent!" or "That was my response"
- Agent appears to respond to its own previous message unprompted

### Cause A — `is_bot_message` not set correctly

Any message stored in the `messages` table with `is_bot_message = 0` is treated as a new user message by the message loop. If a bot-originated message is stored this way, the agent fires again to "respond" to it.

**Check:**
```bash
sqlite3 store/messages.db "
  SELECT id, sender_name, content, is_bot_message
  FROM messages
  WHERE chat_jid = 'tg:YOUR_JID'
  ORDER BY timestamp DESC
  LIMIT 10;
"
```

Any row with `is_bot_message = 0` and `sender` ending in `@ipc` is the problem. This was a known bug in `src/ipc.ts` (fixed 2026-03-31) — if you see it recurring, check that `processIpcMessageData()` is storing with `is_bot_message: true`.

### Cause B — Agent outputting text after calling `send_message`

The agent calls `send_message` (which delivers immediately) and then also outputs text (which delivers when the run ends). Both reach the user.

**Fix**: The group's `CLAUDE.md` must explicitly tell the agent that text output is the delivery mechanism and `send_message` is only for mid-run updates or cross-group delegation. Add `<internal>` tag guidance so post-tool commentary is suppressed:

```markdown
For normal replies, respond with text. Do not call send_message for regular conversation.
If you do call send_message, wrap any follow-up text in <internal> tags:
<internal>Done.</internal>
```

---

## In-Memory Cache

The host process caches session IDs in memory. After modifying SQLite directly, **you must restart the host** for changes to take effect.

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user restart nanoclaw
```