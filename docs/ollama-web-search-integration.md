# Ollama Web Search Integration

> Design doc for web search support on non-Anthropic endpoints.

---

## Problem

Claude's built-in `WebSearch` and `WebFetch` are `type: "server_tool_use"` — Anthropic executes them server-side during `/v1/messages` processing. When a group uses a non-Anthropic endpoint (e.g. `ollama`, `zai`), those providers don't implement this mechanism, so web search silently fails.

## Solution

A `nanoclaw-web-search` MCP server that routes web search requests through the credential proxy. The proxy injects real API keys so containers never see them. Per-group vendor override follows the same pattern as `endpoint` for inference.

## Architecture

```
Agent calls mcp__nanoclaw-web-search__web_search(query, max_results)
    ↓
MCP server inside container POSTs to credential proxy /web_search
    ↓
Proxy reads X-Nanoclaw-Web-Search-Vendor header (default: "ollama")
    ↓
Proxy looks up vendor in web search routing table
    ↓
Proxy injects Authorization: Bearer {real_api_key}
    ↓
Proxy forwards to upstream (e.g. https://ollama.com/api/web_search)
    ↓
Results returned to MCP server → agent
```

## Configuration

### secrets.env

```bash
# ~/.config/nanoclaw/secrets.env
OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api
OLLAMA_WEB_SEARCH_API_KEY=your-key
```

Convention: `{VENDOR}_WEB_SEARCH_BASE_URL` + `{VENDOR}_WEB_SEARCH_API_KEY`. Scanned by `scanWebSearchEndpoints()` in `src/env.ts`.

### containerConfig

```json
{
  "webSearchVendor": "ollama",
  "mcpServers": {
    "nanoclaw-web-search": {
      "command": "node",
      "args": ["/app/mcp-servers/nanoclaw-web-search/dist/index.js"]
    }
  }
}
```

`webSearchVendor` defaults to `"ollama"` if omitted.

## MCP Tools

| Tool | Method | Params |
|------|--------|--------|
| `web_search` | POST `/web_search` | `query` (string), `max_results` (1–10, default 5) |
| `web_fetch` | POST `/web_fetch` | `url` (string) |

## Key Files

| File | Role |
|------|------|
| `src/env.ts` | `scanWebSearchEndpoints()` — discovers vendor pairs |
| `src/credential-proxy.ts` | Path-based routing for `/web_search`, `/web_fetch` |
| `src/types.ts` | `webSearchVendor?: string` on `ContainerConfig` |
| `src/container-runner.ts` | Injects `NANOCLAW_WEB_SEARCH_VENDOR`, proxy host/port env vars |
| `container/mcp-servers/nanoclaw-web-search/` | MCP server (web_search + web_fetch tools) |
| `container/agent-runner/src/index.ts` | Appends `X-Nanoclaw-Web-Search-Vendor` to `ANTHROPIC_CUSTOM_HEADERS` |
| `container/skills/web-search/SKILL.md` | Agent guidance — prefer MCP tools over built-in |

## Security

- Containers never see API keys — proxy injects them at request time
- MCP server only knows proxy host/port and vendor name
- Routing headers (`X-Nanoclaw-Web-Search-Vendor`) stripped before forwarding upstream
- All errors go to stderr; stdout is MCP protocol only

## Implementation Notes

The original design considered transparent proxy interception (intercepting built-in WebSearch/WebFetch at the proxy level). This was rejected because those tools are server-side — Anthropic's API executes them, not the SDK. The request never reaches the proxy.

The MCP server approach was chosen instead:
- Agent calls MCP tools explicitly (guided by the `web-search` skill document)
- MCP server is a thin wrapper that POSTs to the credential proxy
- Proxy handles vendor resolution and credential injection
- Works regardless of inference endpoint

### Open Questions (Resolved)

- **Q: Can we intercept WebSearch at the proxy?** No — server-side tool, never hits the proxy.
- **Q: Multiple custom headers in ANTHROPIC_CUSTOM_HEADERS?** Yes — SDK supports newline-separated headers.
- **Q: What if vendor not configured?** Proxy returns 404 with descriptive error listing available vendors.
