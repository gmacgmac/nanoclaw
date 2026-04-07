# Adding a Proxied MCP Service to NanoClaw

> A recipe for adding a new external API as an MCP tool, routed through the credential proxy so containers never see real secrets.

---

## When to Use This Pattern

Use the **proxy pattern** when:
- Credentials must never touch the container (multi-tenant, security-critical)
- Multiple vendors may provide the same service (e.g. Ollama, Google, Bing for web search)
- Per-group vendor override is needed

Use the **direct pattern** (like `brave-search`) when:
- Single vendor, single API key
- Simpler setup — key injected as env var, MCP server calls upstream directly

---

## Prerequisites

- API key for the target service
- Understanding of the credential proxy (`src/credential-proxy.ts`)
- Familiarity with the MCP server pattern (`container/mcp-servers/brave-search/`)

---

## Steps

### 1. Environment Scanning — `src/env.ts`

Add a `scan{Service}Endpoints()` function that discovers credentials from `secrets.env`.

**Convention**: `{VENDOR}_{SERVICE}_BASE_URL` + `{VENDOR}_{SERVICE}_API_KEY`

```typescript
// Example: scanWebSearchEndpoints() discovers:
//   OLLAMA_WEB_SEARCH_BASE_URL + OLLAMA_WEB_SEARCH_API_KEY
// Returns: { "ollama": { baseUrl: "https://...", apiKey: "xxx" } }
export function scan{Service}Endpoints(): Record<string, EndpointEntry> { ... }
```

**Key points**:
- Reuse the existing `EndpointEntry` interface (`{ baseUrl, apiKey }`)
- Mirror `scanEndpoints()` logic exactly — same file priority, quote stripping, comment handling
- Return map keyed by lowercase vendor name
- Both URL and key must be present for a pair to be included

**Reference**: `scanWebSearchEndpoints()` in `src/env.ts`

---

### 2. Proxy Routing — `src/credential-proxy.ts`

Add path-based routing so the proxy intercepts service-specific requests before inference routing.

**Pattern**:
1. Define constants: paths, vendor header name, default vendor
2. Build routing table at startup from your scan function
3. In the request handler, check `req.url` against your paths **before** inference routing
4. Read vendor from your custom header (with default)
5. Look up vendor in routing table → 404 if not found
6. Inject `Authorization: Bearer {apiKey}`
7. Strip routing headers, forward to upstream, pipe response back

```typescript
const SERVICE_PATHS = ['/your_path_1', '/your_path_2'];
const SERVICE_VENDOR_HEADER = 'x-nanoclaw-{service}-vendor';
const DEFAULT_SERVICE_VENDOR = 'your_default';
```

**Security**: Strip all routing headers (`X-Nanoclaw-*`, `x-api-key`) before forwarding. Unknown vendor returns 404 with available vendors listed.

**Reference**: Web search routing block in `startCredentialProxy()` in `src/credential-proxy.ts`


---

### 3. MCP Server — `container/mcp-servers/{service-name}/`

Create a new MCP server that calls the credential proxy, not the upstream API directly.

**Directory structure** (mirror `brave-search`):
```
container/mcp-servers/{service-name}/
├── package.json      # Pinned deps: @modelcontextprotocol/sdk, zod, typescript, @types/node
├── tsconfig.json     # Mirror brave-search config (ES2022, NodeNext, strict)
└── src/
    └── index.ts      # MCP server implementation
```

**Implementation pattern**:
```typescript
// Read proxy connection from env (set by container-runner)
const host = process.env.NANOCLAW_PROXY_HOST;
const port = process.env.NANOCLAW_PROXY_PORT;
const vendor = process.env.NANOCLAW_{SERVICE}_VENDOR || 'default';

// Call proxy, not upstream
const url = `http://${host}:${port}/your_path`;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Nanoclaw-{Service}-Vendor': vendor,
  },
  body: JSON.stringify({ ... }),
});
```

**Security rules**:
- No secrets hardcoded — proxy injects them
- No logging to stdout (reserved for MCP protocol)
- All errors to stderr
- Use Node.js built-in `fetch` — no third-party HTTP clients
- Pin exact dep versions (no `^` or `~`)
- Install with `--ignore-scripts`

**Reference**: `container/mcp-servers/nanoclaw-web-search/src/index.ts`

---

### 4. Per-Group Integration — `src/types.ts` + `src/container-runner.ts`

Wire the new service into the container configuration and env var injection.

**types.ts**: Add vendor config to `ContainerConfig`:
```typescript
/** Vendor for {service} traffic. Defaults to "default_vendor" if omitted. */
{service}Vendor?: string;
```

**container-runner.ts** — in `buildContainerArgs()`:
```typescript
// Inject proxy connection details when this group uses the MCP server
if (group.containerConfig?.mcpServers?.['{service-name}']) {
  const vendor = group.containerConfig?.{service}Vendor ?? 'default';
  args.push('-e', `NANOCLAW_{SERVICE}_VENDOR=${vendor}`);
  args.push('-e', `NANOCLAW_PROXY_HOST=${CONTAINER_HOST_GATEWAY}`);
  args.push('-e', `NANOCLAW_PROXY_PORT=${CREDENTIAL_PROXY_PORT}`);
}
```

**agent-runner** (`container/agent-runner/src/index.ts`):
- Add `{service}Vendor?: string` to `ContainerInput`
- Append `X-Nanoclaw-{Service}-Vendor` to `ANTHROPIC_CUSTOM_HEADERS` (newline-separated)

**Dockerfile**: Add build step:
```dockerfile
COPY mcp-servers/{service-name}/ /app/mcp-servers/{service-name}/
RUN cd /app/mcp-servers/{service-name} && npm install --ignore-scripts && npm run build
```

---

### 5. Container Skill — `container/skills/{service-name}/SKILL.md`

Create a skill document that teaches the agent about the new tools.

**Format** (YAML frontmatter + markdown):
```yaml
---
name: {service-name}
description: Brief description of what the tools do.
---
```

Include: tool names with `mcp__{server-name}__{tool}` format, parameter tables, when to use, limitations.

Skills are auto-mounted to groups based on `containerConfig.skills` — no extra wiring needed.

**Reference**: `container/skills/web-search/SKILL.md`

---

### 6. Testing

Test each layer independently:

| Layer | Test file | What to test |
|-------|-----------|-------------|
| Env scanning | `src/env.test.ts` | Discovery, missing pairs, priority, quote stripping |
| Proxy routing | `src/credential-proxy.test.ts` | Path detection, vendor lookup, 404, header injection/stripping |
| MCP server | `src/{service}.test.ts` or inline | Happy path, HTTP errors (404/429/500), missing env vars |
| Container integration | `src/container-runner.test.ts` | Env var injection, defaults, absence, coexistence with other MCPs |
| Agent-runner headers | `src/web-search.test.ts` (or similar) | Custom header format, defaults, priority chain |

Use real HTTP servers in tests where possible (not just mocks) for proxy and MCP server tests.

---

## Group Configuration Example

```json
{
  "endpoint": "ollama",
  "{service}Vendor": "your_vendor",
  "mcpServers": {
    "{service-name}": {
      "command": "node",
      "args": ["/app/mcp-servers/{service-name}/dist/index.js"]
    }
  }
}
```

**secrets.env**:
```bash
YOUR_VENDOR_{SERVICE}_BASE_URL=https://api.example.com
YOUR_VENDOR_{SERVICE}_API_KEY=your-key-here
```

---

## Reference Files

| File | Role |
|------|------|
| `src/env.ts` | Endpoint scanning (add your scan function here) |
| `src/credential-proxy.ts` | Proxy routing (add your path routing here) |
| `src/types.ts` | `ContainerConfig` interface (add vendor field) |
| `src/container-runner.ts` | Container env var injection (add conditional block) |
| `container/agent-runner/src/index.ts` | Custom headers (append your vendor header) |
| `container/mcp-servers/` | MCP server implementations |
| `container/skills/` | Agent skill documents |
| `container/Dockerfile` | Docker image build steps |

---

## Proxy vs Direct — Quick Decision

| Question | Proxy | Direct |
|----------|-------|--------|
| Credentials touch container? | No | Yes (env var) |
| Multiple vendors? | Yes (per-group override) | No (single vendor) |
| Routing complexity | Higher (proxy path + header) | Lower (direct API call) |
| Example | `nanoclaw-web-search` | `brave-search` |

---

*Derived from the web search proxy routing implementation (April 2026). See `cortex-tasks/agentic-tools/nanoclaw_2026-04-06_web-search-proxy-routing/` for the full task set.*
