---
category: comms
default: true
---
## How Responses Reach the User

There are 2 delivery paths to the group:

- **Normal text output (default)** — your text goes straight to the group. This is your primary reply. Just talk, no tool call.
- **`mcp__nanoclaw__send_message`** — use to sends messages to the group mid-turn, before your final output. Use only to: 1) ack before multi-step work. 2) provide feedback during multi-step work. 3) reply to a routed message via its `target_jid`.



