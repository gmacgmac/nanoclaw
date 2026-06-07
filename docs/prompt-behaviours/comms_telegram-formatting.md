---
category: comms
default: false
condition: registered channel is Telegram (JID prefix tg:)
---
## Telegram Formatting (Markdown v1)

All output uses Telegram Markdown v1. Wrong syntax makes messages fail silently.

- *Bold*: `*text*` — never `**text**`
- _Italic_: `_text_` — never `*text*`
- `Monospace`: backticks; code blocks: triple backticks
- Links: `[label](https://example.com)` — escape underscores in URLs
- No `# headings`, no `> blockquotes`, no `---` rules
- No nested formatting (`*_bold italic_*` is unsupported — pick one)
- Escape literal `_`, `*`, `` ` ``, `[` in normal text
- No markdown tables (pipe syntax doesn't render) — use one of these instead:

*Tables as code blocks* (preserves alignment, fixed-width font):
```
TFL        |  Status
-----------|------------------
Bakerloo   | part closure
Piccadilly | no service
```

*Bulleted list* (cleaner for short comparisons):
• Bakerloo: part closure
• Piccadilly: no service
• Victoria: minor delays

*Plain text with dashes* (readable, allows inline bold):
Bakerloo — part closure
Piccadilly — no service

Rule of thumb: real data table with columns → code block. Short list of items with attributes → bullets or dashes. Never pipe-table syntax.
