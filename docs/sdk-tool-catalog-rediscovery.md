---
title: SDK Tool Catalog Rediscovery
created: 2026-06-02
last_updated: 2026-06-02
---

# SDK Tool Catalog Rediscovery

> **Category**: `nanoclaw-container`, `nanoclaw-security`  
> **When**: After any `@anthropic-ai/claude-agent-sdk` or Claude CLI version bump  
> **Purpose**: Re-derive the true built-in tool catalog and safely update `tool-allowlist.json`

---

## Security Posture

New tools are **denied-by-default**. Any tool absent from `tool-allowlist.json` can never resolve, regardless of group config. This procedure is the controlled gate for admitting new tools after an SDK upgrade.

---

## Verified SDK Semantics (0.3.147)

These semantics were empirically verified via disposable-branch spikes. Future agents should not re-derive them — reference this section.

| Primitive | Actual Behavior |
|-----------|-----------------|
| `tools` | **The authoritative gate.** Constrains everything including preset-injected CLI tools. `['Read','Edit']` → exactly those two resolve. |
| `tools: []` | Zero built-ins resolve. |
| `allowedTools` | Auto-approve list only — does NOT restrict. `['Read']` still resolves all tools in the `tools` set. |
| `disallowedTools` | Hard removal — removes listed names from the resolved set. |
| `toolAliases` | Does NOT remove or reroute tools — dead end for Bash swap. |

**Key insight**: `options.tools` is the only primitive that acts as a whitelist gate. The nanoclaw resolution model uses it as the sole enforcement point.

---

## Resolution Model (Reference)

```
ceiling   = parse(tool-allowlist.json)  ??  VERIFIED_CATALOG (code fallback)
resolved  = ceiling
            − group.deniedTools              // container_config, per-group
            − Bash             (if approvalMode)
            − WebSearch/WebFetch (if !nativeWebTools)
            + mcp__nanoclaw__*               // IPC always on, never denied
```

Files:
- Ceiling file: `repo/tool-allowlist.json`
- Code fallback: `repo/src/config.ts` → `VERIFIED_CATALOG`
- Resolution logic: `repo/container/agent-runner/src/index.ts` → `runQuery`

---

## Production Environment Flags

The probe MUST set these flags to match the production container environment. Without them, the SDK may resolve a different tool set.

```json
{
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
}
```

Source: `repo/src/container-runner.ts` (settings file generation).

---

## The Probe Technique

A minimal disposable harness that calls `query()`, reads the `init` message's resolved `tools` array, and aborts before any model turn. No API credentials are consumed — the `init` event emits locally before the first API call.

### Prerequisites

- The SDK package installed at the new version (`@anthropic-ai/claude-agent-sdk@X.Y.Z`)
- A temporary working directory (will be discarded)
- Node.js (same version as production)

### Probe Script

Create a temporary file (e.g., `probe-tools.mjs`):

```javascript
import { query } from '@anthropic-ai/claude-agent-sdk';

const env = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // Model doesn't matter — init resolves tools before any API call
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
};

const controller = new AbortController();

const conversation = query({
  prompt: 'test',
  options: {
    // permissionMode ensures the SDK resolves the full tool set
    // (same as production bypassPermissions path)
    permissionMode: 'bypassPermissions',
    sdkEnv: env,
  },
  abortSignal: controller.signal,
});

for await (const message of conversation) {
  if (message.type === 'system' && message.subtype === 'init') {
    const tools = message.tools?.map(t => t.name) ?? [];
    const builtins = tools.filter(t => !t.startsWith('mcp__'));
    console.log(`\nResolved ${builtins.length} built-in tools:\n`);
    console.log(JSON.stringify(builtins.sort(), null, 2));
    controller.abort();
    break;
  }
}

process.exit(0);
```

### Run

```bash
node probe-tools.mjs
```

The script prints the sorted list of built-in tool names and exits. No model turn occurs, no tokens are consumed.

---

## The Diff Step

Compare the probe output against the current catalog:

1. Read `repo/tool-allowlist.json` → `tools` array (current ceiling)
2. Read `repo/src/config.ts` → `VERIFIED_CATALOG` (code fallback)
3. Diff against the probe output:

```bash
# Save probe output to a file, then:
diff <(jq -r '.tools[]' repo/tool-allowlist.json | sort) <(sort probe-output.txt)
```

Classify differences:
- **NEW** (in probe, not in allowlist): Added by the SDK upgrade. Requires decision.
- **REMOVED** (in allowlist, not in probe): Retired by the SDK. Remove from both files.

---

## The Decision Step

For each **NEW** tool:

1. **Research**: What does it do? Check SDK changelog / release notes.
2. **Assess**: Does it need approval gating? Network access? File system access?
3. **Decide**:
   - **Admit**: Add to `repo/tool-allowlist.json` `tools` array AND update `VERIFIED_CATALOG` in `repo/src/config.ts`.
   - **Deny (globally)**: Do NOT add to either file. The tool is permanently blocked for all groups.
   - **Deny (per-group)**: Add to the ceiling (admit globally) but add to specific groups' `deniedTools` in their `container_config`.

For each **REMOVED** tool:

1. Remove from `repo/tool-allowlist.json` `tools` array.
2. Remove from `VERIFIED_CATALOG` in `repo/src/config.ts`.
3. Remove from any group's `deniedTools` if listed there (now a no-op entry).

---

## Update Checklist

After decisions are made:

- [ ] `repo/tool-allowlist.json` updated (add new admitted tools, remove retired)
- [ ] `repo/src/config.ts` `VERIFIED_CATALOG` updated to match
- [ ] `repo/container/agent-runner/src/index.ts` `FALLBACK_CATALOG` updated to match
- [ ] Any per-group `deniedTools` adjustments applied
- [ ] `tsc --noEmit` clean (both host and container packages)
- [ ] Test suite passes
- [ ] Changes take effect on next container spawn (no restart needed for `tool-allowlist.json`)

---

## Cleanup

- Delete the probe script (`probe-tools.mjs`)
- If done on a branch, merge or discard as appropriate
- Log the catalog update to `cortex/INBOX.md` with `[nanoclaw-security]` category

---

## Notes

- The `_reloadNote` in `tool-allowlist.json` confirms per-spawn reads — edits are live without host restart.
- `VERIFIED_CATALOG` is the code fallback only; `tool-allowlist.json` is the source of truth at runtime.
- `mcp__nanoclaw__*` tools are IPC and always available — they are not part of the ceiling and should never appear in `tool-allowlist.json`.
- The probe technique was validated against SDK 0.3.147 (2026-06-01). If the SDK changes its `init` message format, adapt the probe script accordingly.
- **`Task` / `Agent` naming split** (SDK ≥ v2.1.63): The subagent tool appears as **`Task`** in `system:init` (what the probe sees, what `options.tools` filters against, what `tool-allowlist.json` must list) but as **`Agent`** in `tool_use` invocation blocks. When diffing probe output against the allowlist, `Task` in the probe = the subagent tool = correct entry in the allowlist. Do not add `Agent` as a separate entry — it would be a duplicate that resolves nothing. Empirically confirmed 2026-06-02: denying `Task` in `deniedTools` removed the `Agent` capability entirely.
- **`RemoteTrigger`** and **`TodoWrite`** are intentionally absent from `tool-allowlist.json`. They are permanently blocked for all groups. If the probe shows them in a future SDK version, the default decision is deny — revisit only if there is a concrete use case.
