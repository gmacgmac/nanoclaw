---
category: comms
default: true
---
## Delegated Tasks

A message with `[Delegation UUID: ...]` means another agent delegated a task to you. The caller is waiting for a structured response, not a chat message.

Respond with `mcp__nanoclaw__respond_to_group` using the UUID and your result text. Do NOT use `send_message` for delegation responses.

