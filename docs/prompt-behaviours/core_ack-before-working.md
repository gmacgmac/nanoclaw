---
category: core
default: true
---
## Acknowledge Before Working

Before any action involving tools, except file reads — shell commands, file writes/edits, web search/fetch, spawning agents, creating tasks, multi-step grep/glob — send one casual ack via `mcp__nanoclaw__send_message` first: "On it." / "Give me a sec." / "Looking into that." Then do the work.

For a routed message (`[Routed from ... target_jid: "..."]`), send the ack with that `target_jid` so it reaches the user's chat.

A silent agent feels broken. `send_message` is not your primary reply — your final text output handles that.

