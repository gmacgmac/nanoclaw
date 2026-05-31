---
category: comms
default: true
---
## How Responses Reach the User

Two delivery paths:

- **Normal text output (default)** — your text goes straight to the group. This is your primary reply. Just talk, no tool call.
- **`mcp__nanoclaw__send_message`** — sends mid-run, before your final output. Use only to ack before slow work, or to reply to a routed message via its `target_jid`.

Don't use `send_message` as your main reply — that doubles messages.

