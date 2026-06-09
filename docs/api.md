---
title: NanoClaw Management API
created: 2026-06-09
last_updated: 2026-06-09
---

# NanoClaw Management API

REST API for managing groups, sessions, presets, and containers.

## Source of Truth

The OpenAPI 3.1 document is the authoritative spec. It is generated live from the route definitions, so it cannot drift from the served endpoints (enforced by `src/api/openapi-drift.test.ts`).

**Endpoint**: `GET http://localhost:3100/api/openapi.json`

> **Override the base URL per environment** — the default in the doc is `localhost:3100`. For other deployments, replace the host in your requests; the paths remain the same.

## Discovery

1. `curl http://localhost:3100/api/openapi.json`
2. Inspect `paths` for available routes and `components.schemas` for request/response shapes.
3. Resolve `$ref` pointers against `components.schemas` to know exact field types.

## Conventions

- **Auth**: routes are protected by auth middleware (`src/api/middleware/auth.ts`). The OpenAPI doc does not declare `securitySchemes` — an unauthenticated request will 401, not 401-with-doc-hint.
- **Write semantics**: all write operations update the in-memory cache and PostgreSQL atomically. **No host restart required** after changes; next container spawn picks them up.
- **Merge vs replace**:
  - `PATCH /api/groups/{jid}` — top-level fields only (name, trigger, requiresTrigger, multiAgentRouter, containerChannel). Does not touch `containerConfig`.
  - `PATCH /api/groups/{jid}/config` — shallow merge of `containerConfig` keys. To safely update `mcpServers` or `additionalMounts` (objects/arrays), `GET` first, merge locally, then PATCH the complete value.
- **JID format**: Telegram groups use `tg:<chat_id>` for main and `tg:<chat_id>:<topic>` for topic-bound groups (e.g. `tg:123456789:fin`).

## Common Operations

| Task | Method + Path |
|------|---------------|
| List groups | `GET /api/groups` |
| Get one group | `GET /api/groups/{jid}` |
| Get containerConfig only | `GET /api/groups/{jid}/config` |
| Update top-level fields | `PATCH /api/groups/{jid}` |
| Patch containerConfig | `PATCH /api/groups/{jid}/config` |
| List presets | `GET /api/presets` |
| Switch preset on a group | `POST /api/groups/{jid}/preset` |
| Health | `GET /api/health` |

Refer to the OpenAPI doc for the full path set and request/response schemas.

## Validation

The drift test in `src/api/openapi-drift.test.ts` asserts that every Express route is documented and vice versa. If you add or change a route, this test must pass.
