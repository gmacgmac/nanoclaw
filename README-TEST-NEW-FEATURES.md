# Testing: Runtime State, Crash Recovery, and Graceful Shutdown

Practical test plan for the features introduced in the `feat(task-scheduler)` batch. Ordered from least disruptive to most.

---

## 1. Runtime State (BE_01) — zero risk

- Schedule a task with `next_run` a few minutes out
- Call `list_tasks` — should show no annotation (idle)
- Wait for it to become due — call `list_tasks` again, expect `[due]`
- Start a chat in the same group so the container is active, then call `list_tasks` — expect `[blocked]`
- Let the chat idle out, watch the task fire — call `get_task` mid-run if you're fast enough to see `Runtime State: running`

---

## 2. Audit Trail (BE_02) — low risk

- Run any task normally
- After it completes, `get_task` should show the run in history with `status: success` and a `duration_ms`
- Check the DB directly if you want: `SELECT * FROM task_run_logs ORDER BY id DESC LIMIT 5` — you should see `started` → `success` transitions (no lingering `started` rows)

---

## 3. Crash Recovery (BE_02 + BE_03) — medium risk, do on a test group

This is the interesting one:

1. Schedule a task with a long-running prompt (e.g., "Wait 60 seconds then respond")
2. While it's running, kill the host process hard: `kill -9 <pid>`
3. Restart the host
4. Check:
   - The group should receive the `⚠️ 1 task run(s) abandoned during last shutdown` alert
   - `task_run_logs` should show the orphaned row closed as `error: 'Host stopped mid-run'`
   - The task's `next_run` should already be advanced to the future (not re-triggering)
   - The task should fire again at its next scheduled time normally

---

## 4. Graceful Shutdown (BE_04) — medium risk

1. Have a task running (or a chat container active)
2. Send `SIGTERM` to the host (normal `kill <pid>` or Ctrl+C)
3. Watch logs — you should see:
   - "Stopping scheduler loop"
   - "_close written to N containers"
   - Container exits within the 30s grace
   - Clean `process.exit(0)`
4. Test the escape hatch: start shutdown, then hit Ctrl+C again — should exit immediately

---

## 5. Double-signal escape (BE_04) — low risk

- Start the host, Ctrl+C once (graceful starts), Ctrl+C again immediately
- Should see instant exit without waiting the 30s

---

## Suggested Order

Do 1 and 2 first — they're purely observational. Then 4 (graceful shutdown is the most operator-visible change). Save 3 (the kill -9 crash test) for last since it's the most disruptive.

All of this can be done against a single test group without affecting your main/production groups.


---

# Testing: Container Security Hardening (v1.22.0)

Security defaults changes: skills default flipped to none, Bash excluded from defaults when approval mode active, WebSearch/WebFetch excluded from defaults, main-only tools hidden from non-main groups.

**Prerequisite**: Switch the test group to `:next` channel (`/version next`) to pick up v1.22.0.

---

## Agent-Testable (automated via chat)

These can be verified by asking the agent inside the container to check itself.

### T1. WebSearch/WebFetch not available by default

- **Group**: Any group on v1.22.0 (`:next`)
- **Test**: Ask the agent: "List all your available tools"
- **Expected**: `WebSearch` and `WebFetch` should NOT appear in the tool list
- **Why**: These are Anthropic-only and excluded from defaults. Web search goes through `nanoclaw-web-search` MCP.

### T2. Bash not available when approval mode active

- **Group**: Any group on v1.22.0 with `approvalMode` not explicitly set to `false`
- **Test**: Ask the agent: "What execution tools do you have? Can you use Bash?"
- **Expected**: Agent should have `mcp__nanoclaw__execute_command` but NOT `Bash`
- **Why**: Bash bypasses approval for mounted paths. execute_command is the safe equivalent.

### T3. execute_command still works for container-local commands

- **Group**: Any group on v1.22.0
- **Test**: Ask the agent to run `ls /workspace/group/`
- **Expected**: Command executes without approval prompt, returns directory listing
- **Why**: Container-local paths don't trigger approval — only write-mounted paths do.

### T4. register_group not visible to non-main

- **Group**: `shelz_main` (the only non-main group) on v1.22.0
- **Test**: Ask the agent: "List all your available MCP tools" or "Can you register a new group?"
- **Expected**: `register_group` should not appear. Agent should say it can't do that.
- **Why**: Tool is now conditionally registered only for isMain groups.

### T5. delegate_to_group not visible to non-main

- **Group**: `shelz_main` on v1.22.0
- **Test**: Ask the agent: "Can you delegate a task to another group?"
- **Expected**: `delegate_to_group` should not appear. Agent should say it can't.

### T6. Main group still has register_group and delegate_to_group

- **Group**: Any main group (e.g. `telegram_main`) on v1.22.0
- **Test**: Ask the agent: "What IPC tools do you have?"
- **Expected**: Both `register_group` and `delegate_to_group` should be listed
- **Why**: Confirms main groups are unaffected by the visibility filter.

### T7. Skills are loaded correctly from explicit list

- **Group**: `choc_main` on v1.22.0
- **Test**: Ask the agent: "What skills do you have loaded?"
- **Expected**: Should show `capabilities`, `status`, `telegram-formatting` only. No `agent-browser`, no `uplynk-api`.

---

## Human-Testable (requires manual observation)

### M1. Normal conversation still works after changes

- **Group**: `choc_main` (switch to `/version next`)
- **Test**: Send a normal message, verify the agent responds coherently
- **Expected**: Normal response, no errors, no missing capabilities for everyday use
- **Rollback**: `/version stable` if broken

### M2. Approval fires for mounted path commands

- **Group**: `telegram_main` or `fin` (groups with `additionalMounts`) on v1.22.0
- **Test**: Ask the agent to write a file to the mounted path (e.g. "Create a test file in the market-dashboard folder")
- **Expected**: You should receive an approval request in Telegram before the command executes
- **Rollback**: Deny the approval, no harm done

### M3. New group without skills config gets no skills

- **Test**: Register a temporary test group with minimal config (no `skills` field)
- **Expected**: Container starts, agent works, but has no skills loaded (check with "What skills do you have?")
- **Cleanup**: Unregister the test group after

### M4. Auto-compaction still works (from earlier change)

- **Group**: `choc_main` on v1.22.0
- **Test**: After a long conversation (or check token-usage.log), verify compaction fires at the configured threshold
- **Expected**: Input tokens drop significantly after threshold is crossed (visible in token-usage.log)

---

## Promotion Checklist

After all tests pass:

```bash
cd repo/container
./scripts/container.sh promote v1.22.0
```

Then switch all groups back to stable: `/version stable` (or they'll pick it up automatically on next container spawn if already on stable channel).

---

# Testing: Capabilities Skill — Dynamic Introspection

The `/capabilities` skill was updated to remove hardcoded tool lists and MCP tool enumerations. It now relies on the agent's own context (MCP tools are self-describing) and live environment checks (env vars, filesystem, binaries).

No code changes — skill-only update. No container rebuild required.

---

## Agent-Testable

### C1. MCP tools not hardcoded in report

- **Group**: Any group with the `capabilities` skill
- **Test**: Run `/capabilities`
- **Expected**: Report lists MCP server *prefixes* (e.g. `mcp__nanoclaw__*`, `mcp__nanoclaw-web-search__*`) — not individual tool names. No static list of `send_message`, `schedule_task`, etc.
- **Why**: MCP tools are self-describing in context. Listing them statically creates stale docs.

### C2. Shell mode reflects actual approval mode

- **Group**: Any group with default config (approvalMode not explicitly false)
- **Test**: Run `/capabilities`
- **Expected**: Shell section shows `execute_command` (approval mode), NOT `Bash`
- **Group**: Any group with `approvalMode: false`
- **Expected**: Shell section shows `Bash` (direct)
- **Why**: Skill now checks `$NANOCLAW_APPROVAL_MODE` env var rather than hardcoding.

### C3. Only connected MCP servers appear

- **Group**: A group WITHOUT `nanoclaw-web-search` in its `mcpServers` config
- **Test**: Run `/capabilities`
- **Expected**: No mention of `mcp__nanoclaw-web-search__*` in the report
- **Group**: A group WITH `nanoclaw-web-search` configured
- **Expected**: `nanoclaw-web-search` prefix appears in the MCP servers section
- **Why**: Previously the skill listed web-search tools for all groups regardless of config.

### C4. Non-main group report is accurate

- **Group**: A non-main group (e.g. `shelz_main`)
- **Test**: Run `/capabilities`
- **Expected**: Report does NOT mention `register_group` or `delegate_to_group` — those tools don't exist in this group's MCP context
- **Why**: Main-only tools are never registered for non-main groups, so they won't appear in the agent's tool context.

### C5. Skill descriptions come from frontmatter

- **Group**: Any group with multiple skills installed
- **Test**: Run `/capabilities`
- **Expected**: Each skill listed with its description pulled from the skill's SKILL.md frontmatter `description` field — not a hardcoded one-liner
- **Why**: Skill now instructs the agent to read frontmatter rather than maintain a static description map.

---

## Human-Testable

### CM1. Report is clean and accurate end-to-end

- **Group**: `choc_main` (has `capabilities`, `status`, `telegram-formatting` skills; no web-search MCP)
- **Test**: Run `/capabilities`
- **Expected**:
  - Skills: `capabilities`, `status`, `telegram-formatting` (with descriptions from their SKILL.md)
  - Shell: `execute_command` (approval mode active)
  - MCP: `nanoclaw` only (no web-search prefix)
  - Binaries: `agent-browser: ✗`
  - System: Main channel yes/no, group memory yes/no
- **Why**: End-to-end smoke test that the report is accurate and not showing phantom tools.
