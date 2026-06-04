# Credential Proxy Extensions

> A reference for extending NanoClaw's credential proxy: adding MCP services, proxy plugins, transform modules, and vendor endpoints (including Amazon Bedrock via Mantle).

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

---

## Proxy Plugin Alternative (Lightweight)

When you need a single vendor's API with custom signing — but don't need structured MCP tool definitions, multi-vendor routing, or per-group vendor override — use a **proxy plugin** instead of a full MCP server.

### When to Use

- Single vendor, single auth scheme
- Agent builds its own tools via raw HTTP (e.g. `curl` through the proxy)
- No MCP server, no Dockerfile changes, no container-runner wiring needed
- A bootstrap skill teaches the agent how to call the API

### Architecture

```
src/proxy-plugins/
├── registry.ts   # ProxyPlugin interface + Map-based registry + factory helpers
├── index.ts      # Barrel — imports each plugin module (triggers self-registration)
└── uplynk.ts     # First plugin: HMAC-SHA256 signing for Uplynk CMS API
```

### How It Works

1. Each plugin module calls `registerProxyPlugin(name, factory)` at import time (same self-registration pattern as channels).
2. At proxy startup, `createProxyPlugins()` calls every factory. Factories return `null` when their required credentials are missing in `secrets.env` — zero overhead for unconfigured plugins.
3. The credential proxy checks active plugins (by `pathPrefixes`) **before** existing inference/web-search routing.
4. A matching plugin handles signing, auth injection, and forwarding to the upstream API. The response is piped back to the caller.

### How It Differs from the MCP Pattern

| Aspect | Full MCP (this doc) | Proxy Plugin |
|--------|---------------------|-------------|
| MCP server | Yes — new server in `container/mcp-servers/` | No |
| Dockerfile changes | Yes — `COPY` + `npm install` + `npm run build` | No |
| Container-runner wiring | Yes — env vars, vendor header injection | No |
| Per-group vendor override | Yes (`containerConfig.{service}Vendor`) | No (single vendor) |
| Agent tool surface | Structured MCP tools (`mcp__server__tool`) | Raw HTTP via proxy (agent builds its own calls) |
| Credential isolation | Same — credentials never enter containers | Same |

### Reference Implementation

`src/proxy-plugins/uplynk.ts` — reads `UPLYNK_USERID` + `UPLYNK_API_KEY` from `secrets.env`, signs requests with HMAC-SHA256 + raw deflate, forwards to `services.uplynk.com`. Agent sends plain JSON to `http://host.docker.internal:<port>/uplynk/<api-path>`.

### When to Upgrade to Full MCP

Upgrade to the full MCP pattern (Steps 1–6 above) when you need:
- Structured tool definitions visible to the agent via `mcp__server__tool`
- Multi-vendor routing with per-group vendor override
- Complex request/response transformation beyond signing

---

*Derived from the web search proxy routing implementation (April 2026). See `cortex-tasks/agentic-tools/nanoclaw_2026-04-06_web-search-proxy-routing/` for the full task set.*

---

## Amazon Bedrock via Mantle (Claude + Open-Source Models)

This section documents the Bedrock-via-Mantle integration and the OpenAI transform plugin. A future maintainer adding models or debugging routing should be able to do so without repeating the research.

---

### Why Mantle, Not the Default Bedrock Flow

The default Claude Code Bedrock integration (`CLAUDE_CODE_USE_BEDROCK=1`) signs requests with **SigV4 inside the container** and talks directly to `bedrock-runtime.amazonaws.com`. This bypasses the credential proxy and requires AWS credentials inside the container — breaking the isolation model.

Mantle is Amazon's API-key-based gateway to Bedrock. The proxy intercepts requests from containers, injects the Bedrock API key, and forwards to `bedrock-mantle.{region}.api.aws`. Containers never see the key. This is the same pattern used for Anthropic, Ollama, and Z.ai.

---

### Two Tracks

Bedrock supports two different API shapes via Mantle. The correct track is determined by the preset's optional `transform` field:

| Track | `transform` field | Upstream API | Auth |
|-------|-------------------|--------------|------|
| **Claude track** | absent (passthrough) | Anthropic Messages API at `/anthropic/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` |
| **Open-source track** | `"openai"` | OpenAI ChatCompletions API at `/v1/chat/completions` | `Authorization: Bearer` |

The Claude track is a near-zero-change: the proxy already speaks the Anthropic Messages format. The open-source track requires bidirectional reshaping — Claude Code speaks Anthropic Messages; Mantle expects OpenAI ChatCompletions.

---

### Bedrock API Key

A Bedrock API key is a bearer token (not SigV4, no AWS SDK needed). Two types exist:

- **Short-term** (≤12 h, recommended for production): generated from AWS Console → Amazon Bedrock → API keys.
- **Long-term** (IAM user, with expiry date, AWS-flagged "exploration only"): acceptable for initial setup.

The `AmazonBedrockLimitedAccess` policy is sufficient for the standard model catalog. `AmazonBedrockMarketplaceAccess` is not needed unless using marketplace models.

> **Short-term key rotation**: Short-term keys expire in ≤12 h. Update both `BEDROCK_API_KEY` and `BEDROCKOSS_API_KEY` in `secrets.env` and restart the host. A rotation automation task is deferred — see PLAN.md "Out of Scope".

---

### Two-Vendor Design (Critical)

The proxy composes `requestPath = basePath + path` where `basePath` is the pathname of the vendor's `_BASE_URL`. **One `BEDROCK_BASE_URL` cannot serve both tracks**:

- **Claude track** needs `basePath=/anthropic` so the SDK's `/v1/messages` becomes `/anthropic/v1/messages`.
- **Transform track** needs `basePath=''` (bare host) so the transform's `/v1/chat/completions` becomes `/v1/chat/completions`.

Using the Claude-track URL for both would produce `/anthropic/v1/chat/completions` on the transform track — wrong.

**Solution**: two vendor entries, same API key:

| Vendor name | `_BASE_URL` | Used by |
|-------------|-------------|---------|
| `bedrock` | `https://bedrock-mantle.us-east-1.api.aws/anthropic` | Claude presets (`endpoint: "bedrock"`, no transform) |
| `bedrockoss` | `https://bedrock-mantle.us-east-1.api.aws` | Open-source presets (`endpoint: "bedrockoss"`, `transform: "openai"`) |

This mirrors the existing multi-vendor pattern in `scanEndpoints()` — no new code needed for vendor discovery.

**`secrets.env` additions:**

```bash
# Amazon Bedrock via Mantle endpoint (us-east-1)
# Short-term bearer token — rotate when expired.

# Claude track: /anthropic prefix → proxy appends /v1/messages → /anthropic/v1/messages
BEDROCK_BASE_URL=https://bedrock-mantle.us-east-1.api.aws/anthropic
BEDROCK_API_KEY=<your-bedrock-api-key>

# Open-source / transform track: bare host → transform appends /v1/chat/completions
BEDROCKOSS_BASE_URL=https://bedrock-mantle.us-east-1.api.aws
BEDROCKOSS_API_KEY=<same-bedrock-api-key>
```

The `/anthropic` suffix on `BEDROCK_BASE_URL` mirrors exactly the Z.ai pattern (`ZAI_BASE_URL=https://api.z.ai/api/anthropic`). See [Endpoint URL Format](#endpoint-url-format--what-goes-in-secretsenv) for the path-composition rule.

---

### Auth Detail

The proxy normally injects `x-api-key`. For the transform track, it switches to `Authorization: Bearer` because the ChatCompletions endpoint expects it. The proxy reads the `X-Nanoclaw-Transform` header to make this decision automatically — no changes to `containerConfig` required.

For the Claude track (no transform header), `x-api-key` is injected as usual. Claude Code also sends `anthropic-version: 2023-06-01` by default; this header passes through the proxy unchanged and is required by Mantle.

### SDK Header and Body Stripping for Non-Anthropic Vendors

The Claude Code SDK injects two fields that Anthropic's own API accepts but strict upstreams like Mantle reject with a 400:

| What | Type | Why stripped |
|------|------|-------------|
| `anthropic-beta` | Request header | SDK auto-negotiates beta features (interleaved thinking, token-efficient tools, etc.). Mantle only supports a subset and rejects unrecognised values. |
| `context_management` | Request body field | SDK sends this for server-side compaction hint negotiation. Mantle does not support it. |

The proxy strips both for any vendor that is not `anthropic`. This is a no-op for Ollama (which silently ignores unknown fields) and has no effect on auto-compaction — compaction is driven by `settings.json` (`autoCompactEnabled` / `autoCompactWindow`) which is written locally at container spawn time from the preset's `compactThreshold`.

---

### Model ID Format

Mantle model IDs differ from the `bedrock-runtime` inference-profile IDs:

| Context | Format example |
|---------|---------------|
| Mantle (Nanoclaw presets) | `anthropic.claude-haiku-4-5` |
| bedrock-runtime inference profile | `us.anthropic.claude-haiku-4-5-v1` |

**Always use the Mantle format** (`vendor.model-name`) in `model-presets.json`. The `us.` cross-region prefix and version suffix (e.g. `v1`) do NOT apply on Mantle. Pin exact IDs from the account's `/v1/models` listing:

```bash
curl https://bedrock-mantle.us-east-1.api.aws/v1/models \
  -H "x-api-key: <your-bedrock-api-key>"
```

**Confirmed working model IDs on this account:**
- Claude: `anthropic.claude-haiku-4-5`
- Open-source: `deepseek.v3.2`, `moonshotai.kimi-k2.5`, `minimax.minimax-m2.5`

> Note: `anthropic.claude-sonnet-4-6` is NOT yet available on this account's Mantle endpoint. Do not add until confirmed.

---

### Preset Examples

```json
{
  "BHaiku4.5": {
    "endpoint": "bedrock",
    "model": "anthropic.claude-haiku-4-5",
    "capabilities": { "vision": true, "thinking": false, "tools": true },
    "contextWindow": 200000,
    "webSearchVendor": "ollama"
  },
  "BKimi2.5": {
    "endpoint": "bedrockoss",
    "model": "moonshotai.kimi-k2.5",
    "transform": "openai",
    "capabilities": { "vision": false, "thinking": true, "tools": true },
    "contextWindow": 131072,
    "webSearchVendor": "ollama"
  },
  "BDeepSeekV3": {
    "endpoint": "bedrockoss",
    "model": "deepseek.v3.2",
    "transform": "openai",
    "capabilities": { "vision": false, "thinking": false, "tools": true },
    "contextWindow": 65536,
    "webSearchVendor": "ollama"
  },
  "BMiniMax": {
    "endpoint": "bedrockoss",
    "model": "minimax.minimax-m2.5",
    "transform": "openai",
    "capabilities": { "vision": false, "thinking": false, "tools": true },
    "contextWindow": 1000000,
    "webSearchVendor": "ollama"
  }
}
```

> ⚠️ **Web search constraint**: `webSearchVendor: "ollama"` is set here as a temporary measure. The org disallows Ollama for Bedrock groups per original requirements. A native AWS/Bedrock web-search alternative has not been confirmed — review this before using Bedrock groups in production. See PLAN.md "Open Questions".

---

### The OpenAI Transform Plugin

#### Overview

The transform plugin is activated when a preset has `transform: "openai"`. It performs bidirectional translation between the Anthropic Messages API shape (what Claude Code sends) and the OpenAI ChatCompletions shape (what Mantle's open-source model endpoint expects).

#### Location and Structure

```
src/proxy-plugins/transforms/
├── registry.ts   # TransformPlugin interface + Map-based lookup (mirrors proxy-plugins/registry.ts)
├── openai.ts     # Bidirectional Anthropic ↔ OpenAI transform (request, response, streaming SSE)
└── index.ts      # Barrel export
```

Zero external dependencies. All transform logic is pure functions — easy to audit and test.

#### Activation

1. Preset defines `transform: "openai"`.
2. Host (`src/index.ts`) threads `transform` from the resolved preset into `ContainerInput`.
3. `ContainerInput` carries it to the agent-runner inside the container.
4. Agent-runner conditionally appends `X-Nanoclaw-Transform: openai` to `ANTHROPIC_CUSTOM_HEADERS` (only when set — Claude-track requests stay clean).
5. Proxy reads the header, looks up the transform in the registry, and applies it.

#### Header Flow Diagram

```
model-presets.json
  └─ preset.transform: "openai"
        ↓ src/index.ts (spawn site)
  ContainerInput.transform
        ↓ container/agent-runner/src/index.ts
  ANTHROPIC_CUSTOM_HEADERS += "X-Nanoclaw-Transform: openai"
        ↓ HTTP request to credential proxy
  proxy reads X-Nanoclaw-Transform header
        ↓ src/credential-proxy.ts
  transformRegistry.get("openai") → apply transform
        ↓ outbound to Mantle
  POST /v1/chat/completions (OpenAI shape)
        ↓ response
  transform reshapes back to Anthropic Messages shape
        ↓ response to container
  Claude Code receives familiar Anthropic format
```

The `X-Nanoclaw-Transform` header is always stripped before the request is forwarded to Mantle.

#### Transform Mapping

**Request (Anthropic → OpenAI):**
- Top-level `system` → OpenAI system message prepended to `messages[]`
- `messages[].content` arrays → OpenAI string/parts format
- `max_tokens` → unchanged
- `tools` / `tool_use` / `tool_result` → `tools` / `tool_calls` / `role: "tool"` (tool-use round-trip fully mapped)
- `stream` flag → passthrough

**Response non-stream (OpenAI → Anthropic):**
- `choices[0].message` → Anthropic `content` blocks
- `stop_reason` mapping: `stop` → `end_turn`, `length` → `max_tokens`, `tool_calls` → `tool_use`

**Streaming SSE (OpenAI chunks → Anthropic SSE event sequence):**
- `chat.completion.chunk` SSE events → `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` event sequence
- Fully buffered and re-emitted — no partial-event leakage
- Tool call streaming supported

#### Unknown Transform Names

If `X-Nanoclaw-Transform` is set to a name not in the registry, the proxy falls through to passthrough (safe default). This prevents hard failures if a preset specifies a transform that hasn't been deployed yet.

#### Adding a New Transform

1. Create `src/proxy-plugins/transforms/{name}.ts` implementing the `TransformPlugin` interface (see `openai.ts` as reference).
2. Register it: call `transformRegistry.set("{name}", yourTransform)` at the bottom of the file.
3. Import it in `src/proxy-plugins/transforms/index.ts` (triggers self-registration).
4. Add `"{name}"` to the `TransformName` type and `VALID_TRANSFORMS` allowlist in `src/presets.ts`.
5. Write unit tests for request, non-stream response, and streaming SSE paths.

---

### Non-Transform Path Unchanged

The transform integration is strictly additive. When `X-Nanoclaw-Transform` is absent (all existing Claude/Ollama/Z.ai groups), the proxy behaves byte-for-byte identically to before. Zero regression risk for existing groups.

---

*Added 2026-06-03. Source tasks: `cortex-tasks/nanoclaw/nanoclaw-mcp_proxy_2026-06-02_bedrock-mantle-and-transform/` (BE_01–MANUAL_01).*


---

## Amazon Bedrock via the Invoke API (Direct) + Auth Modes

This section documents the direct `bedrock-runtime` integration and the pluggable per-vendor auth-mode system. It is separate from the Mantle section above — Mantle is a gateway with its own API shape; this path talks to `bedrock-runtime` directly using Claude Code's native Bedrock SDK mode.

---

### Why Direct Invoke

Sonnet (and the full Anthropic model catalog) is available on `bedrock-runtime` but not on Mantle for this account. The Invoke API is the standard AWS Bedrock path — model id in the URL, binary eventstream responses. Claude Code natively speaks this shape when `CLAUDE_CODE_USE_BEDROCK=1` is set, so **no transform or eventstream decoder is needed in the proxy**. The proxy's only job is auth injection.

---

### Two Independent Switches

The direct-invoke integration is controlled by two composable switches:

| Switch | Level | Where set | Values |
|--------|-------|-----------|--------|
| **Auth mode** | Per-vendor | `{VENDOR}_AUTH` in `secrets.env` | `x-api-key` (default), `bearer`, `sigv4` |
| **SDK mode** | Per-preset | `sdkMode` in `model-presets.json` | `anthropic` (default), `bedrock` |

#### Auth mode (`{VENDOR}_AUTH`)

Determines how the proxy authenticates the outbound request to the upstream vendor. Absent ⇒ `x-api-key` (today's default, byte-for-byte unchanged).

- **`x-api-key`** — injects `x-api-key: <VENDOR_API_KEY>`. All existing vendors use this implicitly.
- **`bearer`** — strips the SDK's placeholder `Authorization: Bearer` header and injects `Authorization: Bearer <VENDOR_API_KEY>`. Used for Bedrock API keys against `bedrock-runtime`.
- **`sigv4`** — strips auth headers, fetches host IAM-role credentials, SigV4-signs the request, injects `Authorization`, `X-Amz-Date`, `X-Amz-Content-Sha256`, and `X-Amz-Security-Token` (when session token present). No `_API_KEY` required — creds come from the host role.

Each vendor may also set `{VENDOR}_REGION` (e.g. `BEDROCKRT_REGION=us-east-1`). Required for `sigv4`; used by the Bedrock SDK mode to set `AWS_REGION` in the container.

#### SDK mode (`sdkMode`)

Determines what request/response shape Claude Code emits:

- **`anthropic`** (default, absent) — the standard Anthropic Messages API shape. Used for Anthropic direct, Ollama, Z.ai, and Mantle (Claude track + open-source via transform).
- **`bedrock`** — the container gets `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `ANTHROPIC_BEDROCK_BASE_URL` pointing to the proxy, and a placeholder `AWS_BEARER_TOKEN_BEDROCK`. The SDK then emits Invoke API requests (model id in URL, `anthropic_version` in body) and decodes the binary eventstream response itself.

#### The Full Matrix

| Upstream | SDK mode | Vendor `_AUTH` | Status |
|----------|----------|----------------|--------|
| Mantle (`/anthropic/v1/messages`) | `anthropic` | `x-api-key` | Works (unchanged) |
| Mantle | `anthropic` | `bearer` / `sigv4` | Works once auth mode set |
| `bedrock-runtime` (Invoke API) | `bedrock` | `bearer` | **Phase 1** — Bearer track, dev |
| `bedrock-runtime` (Invoke API) | `bedrock` | `sigv4` | **Phase 2** — IAM role, deploy |

No per-cell code exists — each cell is a `secrets.env` + preset combination resolved at runtime.

---

### Credential Isolation (All Modes)

The container **never** holds AWS credentials:

| Mode | What container sees | What proxy does |
|------|---------------------|-----------------|
| Bearer (`bedrockrt`) | `AWS_BEARER_TOKEN_BEDROCK=placeholder` | Strips placeholder, injects real `Authorization: Bearer <key>` |
| SigV4 (`bedrockiam`) | `AWS_BEARER_TOKEN_BEDROCK=placeholder` | Strips placeholder, fetches host IAM-role creds, SigV4-signs |
| Mantle (`bedrock`/`bedrockoss`) | `ANTHROPIC_BASE_URL=http://proxy:3001` | Injects `x-api-key` or Bearer per track |

The placeholder `AWS_BEARER_TOKEN_BEDROCK` prevents the SDK from attempting in-container SigV4. The proxy receives the placeholder, discards it, and applies the real auth.

---

### SigV4 Signer (`src/aws-sigv4.ts`)

Pure-function AWS Signature Version 4 implementation (~100 LOC, Node `crypto` only, zero deps):

- `signRequestV4(method, url, headers, body, region, service, credentials)` → returns headers to merge onto the outbound request.
- URI-encodes per RFC 3986 (AWS variant — `!`, `'`, `(`, `)`, `*` are encoded).
- Always signs `x-amz-content-sha256` (payload hash).
- Supports session tokens (`x-amz-security-token`).
- **Single-shot signing only** — the proxy buffers the full request body before forwarding. No chunked-payload variant (an S3 concern, not Bedrock).

Inert until called by the proxy's sigv4 path.

### AWS Credential Provider Chain (`src/aws-credentials.ts`)

Host-side credential resolver (~130 LOC, Node built-in `http` only, zero deps):

**Provider order** (first success wins):
1. **Static env** — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (for local testing only).
2. **Container credentials** — ECS task role or EKS Pod Identity. Reads the URL from `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `AWS_CONTAINER_CREDENTIALS_FULL_URI`, one GET request.
3. **EC2 IMDSv2** — instance profile. Token PUT + GET to `169.254.169.254`.

All providers return `{ accessKeyId, secretAccessKey, sessionToken?, expiration? }`. Credentials are cached with a 5-minute-before-expiry refresh. `clearCredentialCache()` exposed for tests.

**IRSA (web-identity → STS)**: a commented seam exists between container-credentials and IMDSv2 — not built until the deploy confirms IRSA rather than Pod Identity.

---

### Model IDs — Direct Invoke vs Mantle

| Context | Format | Example |
|---------|--------|---------|
| Direct Invoke (`bedrock-runtime`) | `us.` cross-region inference-profile | `us.anthropic.claude-sonnet-4-6` |
| Mantle (gateway) | `vendor.model-name` | `anthropic.claude-haiku-4-5` |

Always use the correct format for the endpoint type. The proxy never parses model ids — the SDK builds the URL path from the preset's `model` field.

---

### Defaults-Off Invariant

Everything is inert unless explicitly enabled:

- `{VENDOR}_AUTH` absent ⇒ `x-api-key` (today's behaviour, unchanged).
- `sdkMode` absent ⇒ `anthropic` (today's behaviour, unchanged).
- The `sigv4` code path is fully built and unit-tested but **dead code** until a vendor sets `_AUTH=sigv4` in `secrets.env`.
- Existing Claude/Ollama/Z.ai/Mantle groups are byte-for-byte unaffected.
- Existing proxy and preset tests pass unchanged — that is the regression guard.

---

### `secrets.env` Examples

**Bearer track (Phase 1, dev):**
```bash
BEDROCKRT_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com
BEDROCKRT_API_KEY=<bedrock-api-key>
BEDROCKRT_AUTH=bearer
BEDROCKRT_REGION=us-east-1
```

**SigV4 track (Phase 2, deploy):**
```bash
BEDROCKIAM_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com
BEDROCKIAM_AUTH=sigv4
BEDROCKIAM_REGION=us-east-1
```

No `_API_KEY` for `sigv4` — credentials come from the host's IAM role.

---

### Preset Examples

```json
{
  "BSonnet4.6": {
    "endpoint": "bedrockrt",
    "sdkMode": "bedrock",
    "model": "us.anthropic.claude-sonnet-4-6",
    "capabilities": { "vision": true, "thinking": true, "tools": true },
    "contextWindow": 1000000,
    "webSearchVendor": "ollama"
  },
  "BSonnet4.6-IAM": {
    "endpoint": "bedrockiam",
    "sdkMode": "bedrock",
    "model": "us.anthropic.claude-sonnet-4-6",
    "capabilities": { "vision": true, "thinking": true, "tools": true },
    "contextWindow": 1000000,
    "webSearchVendor": "ollama"
  }
}
```

Key differences from Mantle presets: `sdkMode: "bedrock"` (SDK emits Invoke shape), `us.` model id prefix, no `transform` field (SDK owns the shape).

---

### Adding a New Auth Mode

1. Add the value to `AuthScheme` type and `VALID_AUTH_MODES` in `src/env.ts`.
2. Handle the new mode in the proxy's auth switch (`src/credential-proxy.ts`, inside the passthrough branch after `resolveEndpoint` returns `vendorAuth`).
3. Add tests for the new path in `src/credential-proxy.test.ts`.
4. Document the mode in this section.

The existing auth-mode switch is a simple `switch (vendorAuth)` — adding a case is straightforward.

---

### Implementation Notes

- **BE_04 body-stripping**: The existing non-anthropic body stripping (`anthropic-beta` header, `context_management` body field) does NOT apply to `sdkMode: bedrock` requests. The SDK's Invoke body is passed through intact — it has no `context_management` field and Bedrock does not reject beta headers the same way Mantle does.
- **BE_03 routing-header verification**: Confirmed that `ANTHROPIC_CUSTOM_HEADERS` (carrying `X-Nanoclaw-Endpoint`) rides along on Bedrock-mode requests. The SDK always sends custom headers regardless of mode — routing works unchanged.
- **Endpoint inclusion rule**: `scanEndpoints()` includes a vendor if it has both a `_BASE_URL` and either a `_API_KEY` OR `_AUTH=sigv4`. This allows SigV4 vendors to omit the key.

---

*Added 2026-06-03. Source tasks: `cortex-tasks/nanoclaw/nanoclaw-mcp_proxy_2026-06-03_bedrock-direct-invoke-sigv4/` (BE_01–BE_07, MANUAL_01).*

---

### Curl Test Bedrock Endpoints

Here you go — replace `YOUR_KEY` with your Bedrock API key in each:

**List all available models (OpenAI-shaped endpoint):**
```bash
curl -s 'https://bedrock-mantle.us-east-1.api.aws/v1/models' \
  -H 'x-api-key: YOUR_KEY'
```

**List models (Anthropic-shaped endpoint — may return empty):**
```bash
curl -s 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/models' \
  -H 'x-api-key: YOUR_KEY' \
  -H 'anthropic-version: 2023-06-01'
```

**Claude track — Haiku (Messages API):**
```bash
curl -s -X POST 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages' \
  -H 'x-api-key: YOUR_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"anthropic.claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}'
```

**Open-source track — DeepSeek (ChatCompletions API):**
```bash
curl -s -X POST 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek.v3.2","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}'
```

**Open-source track — Kimi K2.5 (ChatCompletions API):**
```bash
curl -s -X POST 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"model":"moonshotai.kimi-k2.5","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}'
```

**Open-source track — MiniMax (ChatCompletions API):**
```bash
curl -s -X POST 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"model":"minimax.minimax-m2.5","max_tokens":50,"messages":[{"role":"user","content":"Say hi"}]}'
```

Key difference: Claude track uses `x-api-key` + `/anthropic/v1/messages`. Open-source track uses `Authorization: Bearer` + `/v1/chat/completions`.