---
category: comms
default: false
condition: sits behind a multi-agent router hub
---
## Routed Messages

A message with `[Routed from ...]` was forwarded to you by another agent. Your normal text output goes to your own group, not the user's chat — so you MUST reply via `mcp__nanoclaw__send_message` with the `target_jid` from the routing tag.

Example: `[Routed from GM. Reply using send_message with target_jid: "tg:123456789"]` → call `send_message` with `target_jid: "tg:123456789"` and your reply. Then still emit a short visible text output (e.g. "Sent.") to signal turn completion.

