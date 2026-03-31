---
name: telegram-formatting
description: Format messages for Telegram using Markdown v1 syntax. Use when responding to Telegram channels (folder starts with "telegram_" or JID contains "tg:").
---

# Telegram Message Formatting (Markdown v1)

When responding to Telegram channels, use Telegram's Markdown v1 syntax instead of standard Markdown.

## How to detect Telegram context

Check your group folder name or JID:
- Folder starts with `telegram_` (e.g., `telegram_main`, `telegram_work`)
- Or JID contains `tg:` (e.g., `tg:6013943815`)

## Formatting reference

### Text styles

| Style | Syntax | Example | Result |
|-------|--------|---------|--------|
| Bold | `*text*` | `*bold text*` | **bold text** |
| Italic | `_text_` | `_italic text_` | *italic text* |
| Monospace | `` `text` `` | `` `inline code` `` | `inline code` |
| Pre | ` ```text``` ` | ` ```code block``` ` | Code block |

### Code blocks

Use triple backticks for multi-line code:

```
```language
code here
```
```

### Links and mentions

```
[Link text](https://example.com)    # Named link
```

### What NOT to use

- **NO** `**double asterisks**` for bold (shows as literal `**text**`)
- **NO** `__double underscores__` for bold (shows as literal `__text__`)
- **NO** `~~strikethrough~~` (not supported in Markdown v1)
- **NO** `# Headings` (not supported)
- **NO** `> Blockquotes` (not supported)
- **NO** `---` horizontal rules (not supported)

## Quick conversion guide

| Standard Markdown | Telegram Markdown | Notes |
|------------------|-------------------|-------|
| `**bold**` | `*bold*` | Single asterisk |
| `*italic*` | `_italic_` | Use underscore |
| `***bold italic***` | `*_bold italic_*` | Nest inside single asterisk |
| `` `code` `` | `` `code` `` | Same syntax |

## Example message

```
*Daily Update*

_Here's what happened today:_

```tasks
• Completed: Authentication fix
• In Progress: Dashboard redesign
• Blocked: Waiting for API docs
```

Check the details: [View Dashboard](https://example.com/dashboard)
```

## Important notes

1. **Escape special characters** in text that might be interpreted as formatting:
   - To show a literal `*` or `_`, escape with backslash: `\*` or `\_`
2. **Bold + Italic**: Use `*_text_*` (asterisk outside, underscore inside)
3. **No nested formatting** beyond bold+italic - Telegram Markdown v1 is limited
4. **Links work differently** than standard markdown in some clients - always use `[text](url)` format

## Full syntax summary

```
*bold text*
_italic text_
`inline code`
```code block```
[link text](https://url.com)
\*literal asterisk\*
\_literal underscore\_
```