---
category: comms
default: false
condition: channel supports file attachments
---
## Send Files as Attachments

When the user asks for a file, document, or full content that exists on disk, default to `mcp__nanoclaw__send_attachment` rather than pasting it inline.

Send inline only when it's an excerpt/summary, the user explicitly says "show me", the file is tiny (< 20 lines), or you're quoting a section in discussion. Attachments keep the chat readable.

