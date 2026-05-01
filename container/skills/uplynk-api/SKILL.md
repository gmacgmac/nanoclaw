---
name: uplynk-api
description: Access the Uplynk CMS API for managing video assets, slicers, and live events. Authentication is handled automatically by the credential proxy.
---

# Uplynk CMS API

Access the Uplynk CMS API through the credential proxy. Authentication is automatic — you send plain REST requests and the proxy handles signing.

## URL Pattern

```
http://host.docker.internal:${NANOCLAW_PROXY_PORT:-3001}/uplynk/api/{version}/{endpoint}
```

- The proxy strips `/uplynk` and forwards the rest to `https://services.uplynk.com`
- You choose the API version and endpoint path
- Example: `/uplynk/api/v4/assets` → `https://services.uplynk.com/api/v4/assets`

## Quick Start

Verify connectivity by listing assets:

```bash
curl -s "http://host.docker.internal:3001/uplynk/api/v4/assets"
```

If you get a JSON response with `"@type": "Collection"`, the proxy is working.

## How Requests Work

**GET / DELETE** — plain request, no body needed:

```bash
curl -s "http://host.docker.internal:3001/uplynk/api/v4/assets"
```

**POST / PATCH** — send data as a JSON body:

```bash
curl -s -X POST "http://host.docker.internal:3001/uplynk/api/v4/{endpoint}" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

The proxy handles all signing automatically. Never include auth params.

## API Versions

The Uplynk API has multiple versions. The proxy handles signing differences automatically:

| Version | GET/DELETE | POST/PATCH |
|---------|-----------|------------|
| **v4** | `msg+sig` in query string | Auth in query string, data as JSON body |
| **v3** | Same as v4 | Same as v4 |
| **v2** | `msg+sig` in query string | `msg+sig` as form-encoded body (data signed in) |

All versions use the same HMAC-SHA256 signing. The proxy detects the version from the URL path and adjusts automatically. Just use the correct version for the endpoint you're calling.

## Discovering Endpoints

The Uplynk API has many endpoints across assets, slicers, channels, and more. **Do not guess paths** — read the docs:

- **API reference:** https://docs.uplynk.com/reference
- Fetch specific endpoint docs: `https://docs.uplynk.com/reference/{operation_id}.md`
- Each doc includes the HTTP method, path, parameters, and request/response schemas

**Your workflow:**
1. Fetch the docs for the operation you need
2. Read the OpenAPI path from the doc (e.g. `/ingest/cloud-slicers/live/slicers`)
3. Build the proxy URL: `http://host.docker.internal:3001/uplynk/api/v4/{path}`
4. Test with curl, check the response
5. Document what works in your group memory for reuse

## Constraints

- **NEVER** authenticate manually — the proxy handles all signing
- **NEVER** try to read or extract API credentials
- **All requests must go through the proxy** — do not call `services.uplynk.com` directly
- Only **v2, v3, and v4** endpoints are supported — the legacy Slicer API (non-versioned, SHA-1 auth) is not
