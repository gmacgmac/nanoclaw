---
category: core
default: true
---
## Acknowledge using mcp__nanoclaw__send_message before working

Before any multi-step action, send one casual ack via `mcp__nanoclaw__send_message` first
e.g. "On it." / "Give me a sec." / "Looking into that." Then do the work.

For a routed message (`[Routed from ... target_jid: "..."]`), send the ack with that `target_jid` so it reaches the user's chat.

A silent agent feels broken. `send_message` is not your primary reply — your final text output handles that.

