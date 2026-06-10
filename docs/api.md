---
title: NanoClaw Management API
created: 2026-06-09
last_updated: 2026-06-10
---

# NanoClaw Management API

REST API for managing groups, sessions, chats, scheduled tasks, presets, and containers. Base URL `http://localhost:3100` in dev; override per environment.

---

## 1. At a Glance

The OpenAPI 3.1 document is the authoritative spec. It is generated live from route definitions, so it cannot drift from the served endpoints (enforced by `src/api/openapi-drift.test.ts`).

> **Spec**: `GET /api/openapi.json` — returns the full path set, request/response schemas, and auth scheme. This is the source of truth. The cookbook below is a quick reference; the spec is exhaustive.

All routes return JSON. Write operations update the in-memory cache and PostgreSQL atomically. **No host restart required** after changes; the next container spawn picks them up.

---

## 2. Authentication

Auth is enforced by `src/api/middleware/auth.ts`:

- `API_TOKEN` env var **set** — all requests require `Authorization: Bearer <token>`. Missing header → `401`. Wrong token → `403`.
- `API_TOKEN` **unset** (default dev) — all requests allowed, no header required.

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups
```

The OpenAPI spec declares `securitySchemes: { bearerAuth }` and applies it as the top-level default — every path inherits it.

---

## 3. Common Tasks

`{jid}` is the group JID (see §5). `{folder}` is the session folder name. `{id}` is the scheduled-task ID.

### Groups

| Task | Method | Path | Notes |
|------|--------|------|-------|
| List | `GET` | `/api/groups` | Includes JID, name, folder, preset. |
| Get one | `GET` | `/api/groups/{jid}` | 404 if unknown. |
| Create | `POST` | `/api/groups` | Body: group shape. |
| Patch (top-level) | `PATCH` | `/api/groups/{jid}` | `name`, `trigger`, `requiresTrigger`, `multiAgentRouter`, `containerChannel` only. Does not touch `containerConfig`. |
| Delete | `DELETE` | `/api/groups/{jid}` | |
| Get containerConfig | `GET` | `/api/groups/{jid}/config` | |
| Patch containerConfig | `PATCH` | `/api/groups/{jid}/config` | Shallow merge of `containerConfig` keys — see §4. |
| Switch preset | `POST` | `/api/groups/{jid}/preset` | Body `{"preset":"OK2.6"}`. 400 lists available presets if unknown. |

### Config Fields (idempotent add/remove/replace)

For `skills`, `mcp-servers`, `hooks`, `allowed-host-commands`, `denied-tools`, `command-allowlist`:

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET` | `/api/groups/{jid}/{field}` | — | Returns current value. |
| `PATCH` | `/api/groups/{jid}/{field}` | `{ add?: [], remove?: [] }` | Idempotent; validated server-side (skills checked against `container/skills/`, hooks against `docs/hooks/`, host-commands against `GET /api/host-commands`). Unknown entries return `400 INVALID_VALUE`. |
| `PUT` | `/api/groups/{jid}/{field}` | `{ value: ... }` | Replace wholesale. |

> **18 field endpoints** total (6 fields × 3 methods). Prefer these over `PATCH /config` for array/object fields — see §4.

### Chats

`GET` list · `POST` upsert (`/api/chats`) · `GET` one (`/api/chats/{jid}`) · `GET` messages (`/api/chats/{jid}/messages?limit=N&since=ts`, default 50, max 200) · `DELETE` messages (`/api/chats/{jid}/messages?confirm=true`, 400 without confirm). List excludes `__group_sync__`; POST is upsert (no 409).

### Sessions

`GET` list (`/api/sessions`) · `GET` one (`/api/sessions/{folder}`, 404 if none) · `DELETE` clear.

### Scheduled Tasks

`GET` list (`/api/scheduled-tasks?groupFolder=X&status=Y`) · `GET` one (`/{id}`) · `POST` create · `PATCH` partial update (does **not** reschedule — `next_run` takes effect on next tick) · `DELETE` (cascades to `task_run_logs`).

### Presets

| Task | Method | Path |
|------|--------|------|
| List | `GET` | `/api/presets` |
| Health | `GET` | `/api/presets/health` |
| Raw tree | `GET` | `/api/presets/raw` |
| Single CRUD | `GET` / `PUT` / `DELETE` | `/api/presets/{name}` |

### Containers & Admin

| Task | Method | Path | Notes |
|------|--------|------|-------|
| List | `GET` | `/api/containers` | |
| Stop | `POST` | `/api/containers/{id}/stop` | |
| Reload groups | `POST` | `/api/admin/reload-groups` | |
| Health | `GET` | `/api/health` | |

### Discovery (read-only catalogs)

| Task | Method | Path | Notes |
|------|--------|------|-------|
| MCP server catalog | `GET` | `/api/mcp/servers` | Static catalog generated at API startup. 503 if the startup scan failed. |
| Group effective toolset | `GET` | `/api/groups/{jid}/mcp-tools` | Built-in ceiling + MCP catalog + intersection of `deniedTools` with known tools. 404 for unknown JID. |
| Valid host commands | `GET` | `/api/host-commands` | Gated commands (require `allowedHostCommands` opt-in) + ungated commands (always available). |

For request/response schemas: `GET /api/openapi.json` → `components.schemas`.

---

## 4. Patching containerConfig Safely

`PATCH /api/groups/{jid}/config` performs a **shallow merge** of `containerConfig` keys. Two consequences:

- **Top-level scalars** (`model`, `timeout`, `env`) merge cleanly.
- **Arrays and objects** (`skills`, `mcpServers`, `hooks`, `additionalMounts`) are **replaced wholesale** — sending `{"skills": ["new-skill"]}` wipes the existing array.

**Wrong** (clobbers existing skills):

```bash
curl -X PATCH "$API/groups/$JID/config" -H "Authorization: Bearer $API_TOKEN" \
  -d '{"skills": ["new-skill"]}'
```

**Right** — use the dedicated field endpoint, which is idempotent and validated:

```bash
curl -X PATCH "$API/groups/$JID/skills" -H "Authorization: Bearer $API_TOKEN" \
  -d '{"add": ["new-skill"]}'
```

`{add, remove}` are union/diff operations; existing entries are preserved. `PUT` replaces the whole field if you need a clean slate. For object fields (`mcp-servers`), use `GET` first, merge locally, then `PUT`.

---

## 5. Discovery Endpoints

Three read-only endpoints expose catalogs that the host can offer to operators and skills. Use them to validate a `containerConfig` write *before* it lands.

### `GET /api/mcp/servers` — MCP server catalog

Returns the static catalog generated at API startup by a one-shot FS scan + regex over each server's `server.tool(` calls. Contains the always-on `nanoclaw` IPC server plus every opt-in server under `container/mcp-servers/`. Each entry has `name`, `source` (`ipc-builtin` | `opt-in`), and `tools[].name`.

```bash
curl "$API/mcp/servers" -H "Authorization: Bearer $API_TOKEN" | jq .data.servers[].name
# "nanoclaw"
# "brave-search"
# "nanoclaw-transcription"
# "nanoclaw-web-search"
```

**When it 503s**: the startup scan couldn't write `mcp-catalog.json` to the repo root. Check the host log for the underlying error and confirm `cwd` is the repo root.

**When to restart the API**: the catalog is read from disk on every request, but the *file* is only refreshed at startup. Restart the API to pick up newly added `server.tool(` calls.

### `GET /api/groups/{jid}/mcp-tools` — group effective toolset

Returns the per-group view of available tools:

- `ceiling` — built-in tool names from `tool-allowlist.json` (the hard ceiling for every group).
- `mcpAvailable` — the full MCP catalog (same as `GET /api/mcp/servers`).
- `denied` — the **intersection** of `containerConfig.deniedTools` with the union of `ceiling` + every MCP tool name. Entries not matching a known tool are silently dropped, so a typo in `deniedTools` shows up as a missing entry here — not as a 4xx.

```bash
curl "$API/groups/$JID/mcp-tools" -H "Authorization: Bearer $API_TOKEN" | jq .data.denied
# ["send_message"]
```

**Known sharp edge**: `repo/container/agent-runner/src/index.ts` hard-codes `mcp__nanoclaw__*` into the agent's `allowedTools` regardless of `deniedTools`. The concrete-name deny in `options.tools` is the effective gate (the model never sees the denied tool), so the wildcard is defence-in-depth, not a leak. Future hardening: drop the wildcard in favour of the 15 concrete names from the catalog.

### `GET /api/host-commands` — valid host commands

Returns the canonical list of host commands, split into:

- `gated` — commands that require the group to opt in via `containerConfig.allowedHostCommands`. Today: `model`, `version`.
- `ungated` — commands available to every group with no allowlist entry needed. Today: `shutdown`, `stop`, `context`, `newsession`.

```bash
curl "$API/host-commands" -H "Authorization: Bearer $API_TOKEN" | jq .data.gated[].name
# "model"
# "version"
```

`PATCH /api/groups/{jid}/allowed-host-commands` rejects values not in `gated` with `400 INVALID_VALUE`. If a workflow needs a new gated command, the dispatch in `src/host-commands.ts` and the `GATED_HOST_COMMANDS` constant in `src/api/routes/host-commands.ts` must be updated together.

---

## 6. Discovering JIDs

`GET /api/groups` returns the canonical list with JIDs. Formats:

| Channel | JID format | Example |
|---------|-----------|---------|
| Telegram (main) | `tg:<chat_id>` | `tg:123456789` |
| Telegram (topic) | `tg:<chat_id>:<topic>` | `tg:123456789:fin` |
| Discord | `dc:<guild>:<channel>` | `dc:123456:789012` |
| Slack | `slack:<workspace>:<channel>` | `slack:acme:general` |
| Internal | `<name>@internal` | `ops@internal` |

---

## 7. Switching a Preset

```bash
curl -X POST "$API/groups/$JID/preset" -H "Authorization: Bearer $API_TOKEN" \
  -d '{"preset":"OK2.6"}'
```

Unknown preset name → `400` with the list of available preset names in the response body. Preset switch is hot — no restart needed; next container spawn uses the new preset.

---

## 8. Error Codes

| Code | Meaning |
|------|---------|
| `400` | Validation failed, invalid preset name, missing `?confirm=true` on destructive ops, or missing/invalid body shape. |
| `401` | No `Authorization` header (when `API_TOKEN` is set). |
| `403` | Bearer token present but does not match `API_TOKEN`. |
| `404` | Resource not found (unknown JID, folder, task ID). |
| `409` | Duplicate (e.g. task ID already exists). |
| `500` | DB or internal error — check host logs. |

Error bodies are `{ "error": "<message>" }`. The OpenAPI spec documents the per-path response shapes for `4xx` codes.

---

## 9. When to Use psql

Most workflows should go through the API. Drop to direct DB access only for:

- **Test DB create/drop** — operator setup/teardown of the test database.
- **Backup / restore pipelines** — `pg_dump` / `pg_restore` for disaster recovery.
- **Diagnostic queries during incidents** — message counts, schema inspection, joined reports the API does not yet expose.

Everything else (group config, sessions, chats, tasks, presets) goes through the API. Direct DB writes bypass validation, the in-memory cache, and the OpenAPI spec — they will silently drift.

---

## 10. Validation Guarantee

`src/api/openapi-drift.test.ts` asserts the served Express routes and the generated OpenAPI paths are identical sets. Every route is registered via `defineRoute` (`src/api/lib/route-builder.ts`), which writes **both** the Express handler and the OpenAPI path entry from a single declaration. Consequence:

- A served path is always documented.
- A documented path is always served.
- Adding a route without a spec entry is a test failure.

If you add or change a route, this test must pass.
