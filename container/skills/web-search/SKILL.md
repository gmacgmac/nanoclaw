---
name: web-search
description: Search the web and fetch pages using the nanoclaw-web-search MCP tools. Works with any inference endpoint (ollama, zai, anthropic). Use these instead of built-in WebSearch/WebFetch.
---

# Web Search — MCP Tools

Use these MCP tools for all web searching and page fetching. They work with **any** inference endpoint — unlike the built-in `WebSearch`/`WebFetch` which only work with Anthropic's API directly.

## Available Tools

### `mcp__nanoclaw-web-search__web_search`

Search the web. Returns titles, URLs, and content snippets.

| Param | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `query` | string | yes | — | Search query |
| `max_results` | number | no | 5 | 1–10 |

### `mcp__nanoclaw-web-search__web_fetch`

Fetch a web page by URL. Returns page title, text content, and links.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `url` | string | yes | Must be a valid URL |

## When to Use

- **Always prefer these MCP tools** over built-in `WebSearch`/`WebFetch`.
- Built-in web tools are Anthropic server-side tools — they silently fail on non-Anthropic endpoints.
- These MCP tools route through the credential proxy, so they work regardless of your inference provider.

## Troubleshooting

If tools return "NANOCLAW_PROXY_HOST and NANOCLAW_PROXY_PORT must be set":
1. This means the MCP server isn't receiving container env vars.
2. The group's `containerConfig.mcpServers` must include `nanoclaw-web-search`.
3. After adding the MCP server config, you need a fresh session (clear the old session transcript).
4. The Docker image must be rebuilt after container code changes.

## Limitations

- Max 10 results per search.
- Results come from the configured web search vendor (typically Ollama's web search API).
- If the web search vendor is not configured, calls will return a clear error.
