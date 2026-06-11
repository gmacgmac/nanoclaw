---
title: NanoClaw Security Model
created: 2026-04-15
last_updated: 2026-05-31
---

# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |
| Context files (CLAUDE.md, memory, additionalMounts CLAUDE.md) | Scanned | Injection scanner runs before container launch |
| Outbound web requests | Validated | SSRF protection blocks internal/metadata targets |
| Shell commands (write mounts) | Gated | Command approval on by default for groups with write mounts |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The project root is no longer implicitly mounted for any group. Groups that need access to the project root must configure it explicitly via `additionalMounts`. This prevents agents from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Admin Group | Main Group | Non-Main Group |
|-----------|-------------|------------|----------------|
| Send message to own chat | ✓ | ✓ | ✓ |
| Send message to other chats | ✓ | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ | ✓ |
| Schedule task for others | ✓ | ✓ | ✗ |
| View all tasks | Own only | Own only | Own only |
| List registered groups | ✓ | ✓ | ✗ |
| Register new groups | ✓ | ✗ | ✗ |
| Delegate to other groups | ✓ | ✓ | ✗ |
| Respond to a delegation | ✓ | ✓ | ✓ (reply only — requires delegation UUID) |

**Admin tier**: The `is_admin` column on `registered_groups` (set via `setup/register.ts --is-admin`) designates a group as the admin group. The admin group also carries `is_main=1` — admin is a superset of main. Only the admin group can register new groups via the `register_group` MCP tool/IPC verb.

**Group removal is CLI-operator-only**: There is no MCP/IPC removal verb. Removal is performed by the host operator via `setup/unregister.ts` (`npm run unregister`), which transactionally deletes or relocates active tasks, drops the session row, and removes the registration. On-disk directories are kept (soft removal).

### 5. Credential Isolation (Credential Proxy)

Real API credentials **never enter containers**. Instead, the host runs an HTTP credential proxy that injects authentication headers transparently.

**How it works:**
1. Host starts a credential proxy on `CREDENTIAL_PROXY_PORT` (default: 3001)
2. Containers receive `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>` and `ANTHROPIC_API_KEY=placeholder`
3. The SDK sends API requests to the proxy with the placeholder key
4. The proxy strips placeholder auth, injects real credentials (`x-api-key` or `Authorization: Bearer`), and forwards to the upstream endpoint configured for the resolved preset (Anthropic, Ollama, Bedrock, Z.ai, or other vendor registered via the multi-endpoint routing table built by `scanEndpoints()` in `src/env.ts`)
5. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Proxy Plugins**

Proxy plugins extend the credential proxy with custom API signing and forwarding for specific upstream services. They run in the host process (not in containers) and share the same security properties as the core proxy: credentials never enter containers and are only read from `secrets.env` on the host.

Plugins load conditionally — a plugin's factory returns `null` when its required credentials are not configured, so unconfigured plugins add zero overhead and no attack surface. Plugin code executes only in the trusted host process.

Example: the Uplynk plugin reads `UPLYNK_USERID` + `UPLYNK_API_KEY` from `secrets.env`, signs requests with HMAC-SHA256, and forwards to `services.uplynk.com`. Containers send plain JSON to the proxy; signing and credential injection happen entirely on the host side.

**NOT Mounted:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 6. SSRF Protection

Prevents agents from making outbound web requests to internal networks, cloud metadata endpoints, and dangerous schemes. Enabled by default.

**What it blocks:**
- RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Loopback (127.0.0.0/8, ::1)
- Link-local (169.254.0.0/16 — includes AWS/GCP metadata at 169.254.169.254)
- CGNAT / shared address space (100.64.0.0/10 — Tailscale, WireGuard)
- Cloud metadata hostnames (`metadata.google.internal`, `metadata.goog`)
- Non-HTTP schemes (file://, ftp://, gopher://)
- IPv6-mapped IPv4 bypass attempts (::ffff:127.0.0.1, hex notation)

**Where validation happens:** `validateUrl()` runs inside `proxyWebFetch()` in the `nanoclaw-web-search` MCP server — the sole agent-controlled URL entry point. Brave Search and the credential proxy are operator-controlled and out of scope.

**Fail-closed:** DNS resolution failure → request blocked.

**Configuration:** `containerConfig.ssrfProtection` (default: `true`). Accepts `boolean` or `SsrfConfig` object with `allowPrivateNetworks`, `additionalBlockedHosts`, and `additionalAllowedHosts` fields.

### 7. Prompt Injection Scanning

Scans context files on the host **before** container launch. Detects patterns in CLAUDE.md, memory/*.md, and CLAUDE.md files in additionalMounts directories that could manipulate agent behaviour.

**Critical patterns detected:** instruction override attempts, credential exfiltration via curl/wget, secret file reads, base64-encoded command execution, Claude Code settings.json override.

**Warning patterns detected:** suspicious HTML comments, invisible Unicode characters, bidirectional text overrides, hidden HTML content, unusually long lines (>5000 chars).

**Three modes** via `containerConfig.injectionScanMode`:
- `'off'` — skip scanning
- `'warn'` (default) — log findings, continue with launch
- `'block'` — abort launch on critical findings

**Alert notification:** Findings are sent to `NANOCLAW_ALERT_JID` via `routeOutbound()` when configured.

**Where it runs:** `scanContextFiles()` in `runAgent()` (`src/index.ts`), before `runContainerAgent()`. Host-side only — never runs inside the container.

### 8. Command Approval

Human-in-the-loop gate for dangerous shell commands in groups with write-access to real host data.

**When it applies:** Groups with write-access `additionalMounts`. Approval mode is on by default; set `approvalMode: false` explicitly to disable.

**How it works:**
1. `Bash` is excluded from the resolved tool set (when approval mode is active — the default); the model can still call `mcp__nanoclaw__execute_command` as a separate MCP tool, subject to the approval gate and `commandAllowlist`
2. Dangerous commands targeting write-mounted paths (under `/workspace/extra/`) trigger an approval request via IPC → messaging channel
3. User responds yes/no → command executes or is denied
4. Timeout → auto-deny (fail-closed)

**Container-internal paths are always allowed** — the container itself is the security boundary. Only commands referencing write-mounted paths (real host data) require approval.

**Dangerous command categories:** file destruction (`rm -rf`, `find -delete`), permissions (`chmod 777`), data modification (`sed -i`, `mv`, redirects), SQL destructive (`DROP TABLE`, `DELETE FROM` without WHERE), remote code execution (`curl | bash`), shell eval (`bash -c`, `python -e`).

**Configuration:** `containerConfig.approvalMode` (boolean, default: `true`), `approvalTimeout` (10–600s, default 120), `commandAllowlist` (regex patterns that skip approval).

## Privilege Comparison

| Capability | Admin Group | Main Group | Non-Main Group |
|------------|-------------|------------|----------------|
| Project root access | None (use `additionalMounts`) | None (use `additionalMounts`) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | None (use `additionalMounts`) | None (use `additionalMounts`) | None |
| Additional mounts | Configurable | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted | Unrestricted |
| Register new groups | Yes (`register_group` MCP tool) | No | No |
| MCP tools (`mcp__nanoclaw__*`) | All registered tools | All registered tools except admin-only (`register_group`) | All registered tools except main-only and admin-only (conditionally registered at MCP server level based on `isMain` / `isAdmin`) |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Channel Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential proxy (injects auth headers)                       │
│  • Prompt injection scanning (before container launch)           │
│  • Command approval IPC handler (receives/routes approvals)      │
│  • Config validation (containerConfig flags)                     │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed) or execute_command (approval mode is    │
│    on by default — dangerous commands on write mounts are gated)     │
│  • File operations (limited to mounts)                            │
│  • SSRF-validated outbound web requests (nanoclaw-web-search)    │
│  • API calls routed through credential proxy                     │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```
