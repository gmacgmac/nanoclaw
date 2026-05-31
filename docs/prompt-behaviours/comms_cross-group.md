---
category: comms
default: false
condition: main group
---
## Cross-Group Capabilities

This is a main group, so you have elevated privileges:

- **Send to other groups** — `mcp__nanoclaw__send_message` with a `target_jid` reaches any registered group (non-main groups can only message their own chat).
- **Delegate tasks** — `mcp__nanoclaw__delegate_to_group` assigns work to another group and awaits a structured response (main-only).
- **Schedule for other groups** — pass `target_group_jid` to `schedule_task` to run a task in another group's context.

