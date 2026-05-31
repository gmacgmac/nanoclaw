---
category: comms
default: false
condition: telegram channel (folder starts with telegram_)
---
## Telegram Formatting (Markdown v1)

All output uses Telegram Markdown v1. Wrong syntax makes messages fail silently.

- *Bold*: `*text*` — never `**text**`
- _Italic_: `_text_` — never `*text*`
- `Monospace`: backticks; code blocks: triple backticks
- Links: `[label](https://example.com)` — escape underscores in URLs
- No tables, no `# headings`, no `> blockquotes`, no `---` rules
- No nested formatting (`*_bold italic_*` is unsupported — pick one)
- Escape literal `_`, `*`, `` ` ``, `[` in normal text

