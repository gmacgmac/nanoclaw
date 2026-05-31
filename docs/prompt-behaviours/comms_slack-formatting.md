---
category: comms
default: false
condition: slack channel (folder starts with slack_)
---
## Slack Formatting (mrkdwn)

All output uses Slack mrkdwn. Wrong syntax renders as literal text.

- *Bold*: `*text*` (single asterisks)
- _Italic_: `_text_`
- `Monospace`: backticks; code blocks: triple backticks
- Links: `<https://url|link text>` — never `[text](url)`
- Bullets: `•` (no numbered lists)
- Emoji: `:white_check_mark:`, `:rocket:` shortcodes
- Block quotes: `>`
- No `#` headings — use `*Bold text*` instead

