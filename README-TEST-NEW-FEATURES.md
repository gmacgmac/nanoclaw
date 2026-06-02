# Testing: Runtime State, Crash Recovery, and Graceful Shutdown

Practical test plan for the features introduced in the `feat(task-scheduler)` batch. Ordered from least disruptive to most.

---

## 1. Runtime State (BE_01) — ✅ PASSED (2026-06-01)

- Schedule a task with `next_run` a few minutes out
- Call `list_tasks` — should show no annotation (idle)
- Wait for it to become due — call `list_tasks` again, expect `[due]`
- Start a chat in the same group so the container is active, then call `list_tasks` — expect `[blocked]`
- Let the chat idle out, watch the task fire — call `get_task` mid-run if you're fast enough to see `Runtime State: running`

**Observations**: All states confirmed on `testgroup_main`. idle → blocked (caught via `list tasks` while container active) → fired. ~1min delay expected (60s poll + container idle wait). `running` state not catchable via Telegram (container busy); terminal DB watch used instead.

---

## 2. Audit Trail (BE_02) — ✅ PASSED (2026-06-01)

- Run any task normally
- After it completes, `get_task` should show the run in history with `status: success` and a `duration_ms`
- Check the DB directly if you want: `SELECT * FROM task_run_logs ORDER BY id DESC LIMIT 5` — you should see `started` → `success` transitions (no lingering `started` rows)

**Observations**: `get task` confirmed `status: completed`, `last_run` populated, `last_result` present. No lingering `started` rows.

---

## 3. Crash Recovery (BE_02 + BE_03) — ✅ PASSED (2026-06-01)

This is the interesting one:

1. Schedule a task with a long-running prompt (e.g., "Wait 60 seconds then respond")
2. While it's running, kill the host process hard: `kill -9 <pid>`
3. Restart the host
4. Check:
   - The group should receive the `⚠️ 1 task run(s) abandoned during last shutdown` alert
   - `task_run_logs` should show the orphaned row closed as `error: 'Host stopped mid-run'`
   - The task's `next_run` should already be advanced to the future (not re-triggering)
   - The task should fire again at its next scheduled time normally

**Observations**: All checks passed on `testgroup_main`. Alert delivered on restart. `task_run_logs` shows `error | Host stopped mid-run`. Task was `once` type so `next_run` is null and status remains `active` — no re-trigger.

---

## 4. Graceful Shutdown (BE_04) — ✅ PASSED (2026-06-01)

1. Have a task running (or a chat container active)
2. Send `SIGTERM` to the host (normal `kill <pid>` or Ctrl+C)
3. Watch logs — you should see:
   - "Stopping scheduler loop"
   - "_close written to N containers"
   - Container exits within the 30s grace
   - Clean `process.exit(0)`
4. Test the escape hatch: start shutdown, then hit Ctrl+C again — should exit immediately

**Observations**: Must run via `node dist/index.js` directly — `npm start` causes double SIGINT (npm re-sends to process group), which triggers the escape hatch immediately. With direct node: single Ctrl+C → `GroupQueue shutting down` → `All containers exited cleanly` → all bots stopped → clean exit (~2.5s). In-flight message was not delivered — expected, container got `_close` mid-turn.

---

## 5. Double-signal escape (BE_04) — ✅ PASSED (2026-06-01)

- Start the host, Ctrl+C once (graceful starts), Ctrl+C again immediately
- Should see instant exit without waiting the 30s

**Observations**: Confirmed via `npm start` (which naturally double-signals). Saw `Second signal received — forcing immediate exit` immediately after graceful shutdown initiated.

---

## Suggested Order

Do 1 and 2 first — they're purely observational. Then 4 (graceful shutdown is  the most operator-visible change). Save 3 (the kill -9 crash test) for last since it's the most disruptive.

All of this can be done against a single test group without affecting your main/production groups.


---

# Testing: Container Security Hardening (v1.22.0)

Security defaults changes: skills default flipped to none, Bash excluded from defaults when approval mode active, WebSearch/WebFetch excluded from defaults, main-only tools hidden from non-main groups.

**Prerequisite**: Switch the test group to `:next` channel (`/version next`) to pick up v1.22.0.

---

## Agent-Testable (automated via chat)

These can be verified by asking the agent inside the container to check itself.

### T1. WebSearch/WebFetch not available by default — ✅ PASSED (2026-06-01)

- **Group**: Any group on v1.22.0 (`:next`)
- **Test**: Ask the agent: "List all your available tools"
- **Expected**: `WebSearch` and `WebFetch` should NOT appear in the tool list
- **Why**: These are Anthropic-only and excluded from defaults. Web search goes through `nanoclaw-web-search` MCP.

**Observations**: Native `WebSearch`/`WebFetch` absent. `web_search` and `web_fetch` present only as `mcp__nanoclaw-web-search__*` — correct.

### T2. Bash not available when approval mode active — ✅ PASSED (2026-06-01)

- **Group**: Any group on v1.22.0 with `approvalMode` not explicitly set to `false`
- **Test**: Ask the agent: "What execution tools do you have? Can you use Bash?"
- **Expected**: Agent should have `mcp__nanoclaw__execute_command` but NOT `Bash`
- **Why**: Bash bypasses approval for mounted paths. execute_command is the safe equivalent.

**Observations**: No native `Bash` tool present. All groups default to approval mode on (`is_admin=0`, no `approvalMode: false` in DB). Execution goes through `execute_command` only.

### T3. execute_command still works for container-local commands — ✅ PASSED (2026-06-01)

- **Group**: Any group on v1.22.0
- **Test**: Ask the agent to run `ls /workspace/group/`
- **Expected**: Command executes without approval prompt, returns directory listing
- **Why**: Container-local paths don't trigger approval — only write-mounted paths do.

**Observations**: `ls /workspace/group/` returned `CLAUDE.md logs media memory token-usage.log` cleanly. No approval prompt.

### T4. register_group not visible to non-admin groups — ✅ PASSED (2026-06-01)

- **Group**: Any group (none are admin)
- **Test**: Ask the agent: "List all your available MCP tools" or "Can you register a new group?"
- **Expected**: `register_group` should not appear. Agent should say it can't do that.
- **Why**: Tool is conditionally registered only for `isAdmin` groups, not `isMain`. No current groups are admin.

**Observations**: Confirmed absent across all groups. `register_group` is admin-gated, not main-gated. DB confirms `is_admin=0` for all registered groups.

### T5. delegate_to_group not visible to non-main — ✅ PASSED (2026-06-01)

- **Group**: `shelz_main` (Shelley) on v1.22.0
- **Test**: Ask the agent: "Can you delegate a task to another group?"
- **Expected**: `delegate_to_group` should not appear. Agent should say it can't.

**Observations**: Confirmed absent on non-main group. Present on main groups (`delegate_to_group`, `respond_to_group`, `get_registered_groups` visible).

### T6. Main group has delegate_to_group but NOT register_group — ✅ PASSED (2026-06-01)

- **Group**: Any main group (e.g. `telegram_main`) on v1.22.0
- **Test**: Ask the agent: "What IPC tools do you have?"
- **Expected**: `delegate_to_group` present. `register_group` absent (admin-only, no admin groups exist).
- **Why**: Main groups get cross-group IPC tools; `register_group` requires `isAdmin` which is separate from `isMain`.

### T7. Skills are loaded correctly from explicit list — ✅ PASSED (2026-06-01)

- **Group**: `choc_main` on v1.22.0
- **Test**: Ask the agent: "What skills do you have loaded?"
- **Expected**: Nanoclaw skills should be `capabilities`, `status`, `telegram-formatting` only. No `agent-browser`, no `uplynk-api`. Native claude code skills (e.g. `code-review`, `verify`, `run`, etc.) are not controlled by nanoclaw and will also appear — that's expected.

**Observations**: Nanoclaw skills confirmed as `capabilities`, `status`, `telegram-formatting`. Additional native claude code skills present but not nanoclaw-managed.

---

## Human-Testable (requires manual observation)

### M1. Normal conversation still works after changes — ✅ PASSED (2026-06-01)

- **Group**: `choc_main` (switch to `/version next`)
- **Test**: Send a normal message, verify the agent responds coherently
- **Expected**: Normal response, no errors, no missing capabilities for everyday use
- **Rollback**: `/version stable` if broken

**Observations**: Normal response confirmed.

### M2. Approval fires for mounted path commands — ✅ PASSED (2026-06-01)

- **Group**: `telegram_main` or `fin` (groups with `additionalMounts`) on v1.22.0
- **Test**: Ask the agent to write a file to the mounted path (e.g. "Create a test file in the market-dashboard folder")
- **Expected**: You should receive an approval request in Telegram before the command executes
- **Rollback**: Deny the approval, no harm done

**Observations**: Tested on `testgroup_main` with a `tmp/` mount. Approval prompt fired correctly before write executed.

### M3. New group without skills config gets no skills

- **Test**: Register a temporary test group with minimal config (no `skills` field)
- **Expected**: Container starts, agent works, but has no skills loaded (check with "What skills do you have?")
- **Cleanup**: Unregister the test group after

### M4. Auto-compaction still works (from earlier change) — ✅ PASSED (2026-06-01)

- **Group**: `choc_main` on v1.22.0
- **Test**: After a long conversation (or check token-usage.log), verify compaction fires at the configured threshold
- **Expected**: Input tokens drop significantly after threshold is crossed (visible in token-usage.log)

**Observations**: Confirmed working.

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

### C1. MCP tools not hardcoded in report — ✅ PASSED (2026-06-01)

- **Note**: `/capabilities` had a main-channel guard that blocked execution in all current groups. Guard removed from skill (main-channel concept no longer applies).
- **Observations**: Report lists MCP server prefixes (`nanoclaw`, `nanoclaw-web-search`, `nanoclaw-transcription`) — no individual tool names hardcoded.

### C2. Shell mode reflects actual approval mode — ✅ PASSED (2026-06-01)

- **Observations**: Shell section shows `execute_command` (approval mode), Bash disabled. Correct.

### C3. Only connected MCP servers appear — ✅ PASSED (2026-06-01)

- **Observations**: `nanoclaw-web-search` appears on `testgroup_main` (it's connected). Correct.

### C4. Non-main group report is accurate — ✅ PASSED (2026-06-01)

- **Observations**: No `register_group` or `delegate_to_group` in the report. Correct.

### C5. Skill descriptions come from frontmatter — ✅ PASSED (2026-06-01)

- **Observations**: Each skill listed with description from its SKILL.md frontmatter. Confirmed.

---

## Human-Testable

### CM1. Report is clean and accurate end-to-end — ✅ PASSED (2026-06-01)

- **Observations**: Tested on `testgroup_main`. Skills listed with frontmatter descriptions, shell shows approval mode, MCP servers by prefix only, `agent-browser: ✗`, group memory yes, extra mounts 0. Clean and accurate.

---

# Testing: Extra-Mount CLAUDE.md Loading vs. Scanning (Injection Scanner Alignment)

Validation plan for a proposed change: **stop eagerly loading `CLAUDE.md` from `additionalMounts` into the agent's context**, while keeping the host-side injection scanner as the protection layer. This is exploratory — we do **not** change production behaviour until the observations below confirm what actually loads.

## Background — what we're trying to settle

The host mounts external directories at `/workspace/extra/*` (siblings of the agent's cwd `/workspace/group`). Two separate mechanisms decide what enters context:

1. **cwd directory tree** — the group's own `CLAUDE.md` + `@import` chain load eagerly at spawn; `CLAUDE.md` in **subdirectories under cwd** load lazily on navigation (`nested_traversal`).
2. **Additional directories** — governed entirely by the env var `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`. Docs state add-dir `CLAUDE.md` is "not loaded" by default. Set to `1`, it loads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md` from each add-dir at session start.

Because the extra mounts sit **outside** the cwd tree, our hypothesis is that mechanism #1's lazy navigation-load never reaches them — so `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is the **only** path that pulls extra-mount `CLAUDE.md` into context. **If that hypothesis holds, setting the var to `0` disables eager AND on-navigation loading for extra mounts in one move.** This test exists to prove or disprove that.

> The desired end state: extra-mount `CLAUDE.md` does not auto-inject (saves context, shrinks attack surface), the mount stays *accessible*, and the host scans it independently.

## What the scanner covers today (be precise)

The host scanner (`context-scanner.ts`) runs at **container spawn** and scans:

- The group's own `CLAUDE.md` (cwd root)
- `memory/*.md` in the group folder
- `extra/<name>/CLAUDE.md` — the **mount-root** `CLAUDE.md` for each resolved additional mount (added in IMPL_02)

Important nuance: the scanner does **not** parse `@import` directives. It scans `memory/*.md` directly, which covers the group's conventional `@memory/MEMORY.md` import **by coincidence of layout**, not by following imports. A group `CLAUDE.md` that imported `@docs/foo.md` would NOT have `foo.md` scanned today. Likewise, nested `extra/<name>/sub/CLAUDE.md` and any `@import` targets inside an extra-mount `CLAUDE.md` are **not** scanned. Closing those is the open design question.

So: scanning continues regardless of the env var. Disabling eager loading does **not** blind the scanner — it still scans the group `CLAUDE.md` + memory + mount-root `CLAUDE.md` at spawn. What disabling changes is only what the **agent** auto-loads into context.

## Should we disable `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`?

**Not yet — we run the experiment first.** Disabling is the likely outcome, but only after we confirm (below) that `=0` truly closes every load path for extra-mount `CLAUDE.md`. If the tripwire shows a residual lazy-load path, we need to handle that before flipping it.

When we do change it, leave the `additionalDirectories` SDK arg in place — that controls *access* to the mount, which we want to keep. Only the env var (instruction auto-loading) is in question.

---

## The Tripwire: `InstructionsLoaded` hook

`InstructionsLoaded` fires whenever a `CLAUDE.md` / `.claude/rules/*.md` enters context, with a `load_reason` of `session_start`, `nested_traversal`, `path_glob_match`, `include` (= `@import`), or `compact`. It cannot block (observability only) — perfect for proving what loads. We register it with `matcher: "*"` to log `file_path`, `load_reason`, `trigger_file_path` for every instruction-file load.

### Setup

1. Pick a test group with at least one `additionalMount`. **`fin` is ideal — it already has a mount, so no extra setup.** Any group with a mount works; the choice is not significant.
2. In the mount root, place a **benign marker** `CLAUDE.md` containing a unique string, e.g. `MARKER-MOUNT-ROOT-<rand>`.
3. Add a nested marker: `<mount>/sub/CLAUDE.md` containing `MARKER-MOUNT-NESTED-<rand>`.
4. Add an `@import` to the mount-root `CLAUDE.md`: `@./imported.md`, and create `<mount>/imported.md` with `MARKER-MOUNT-IMPORT-<rand>`.
5. Register an `InstructionsLoaded` hook (matcher `*`) that appends `{load_reason, file_path}` to a host-readable log (see below).

### Where the evidence lands

Three independent evidence sources, all host-readable:

| Source | Location | What it shows |
|--------|----------|---------------|
| **InstructionsLoaded tripwire** | Configure the hook (command type) to append JSONL to `groups/<group>/logs/instructions-loaded.jsonl` (or write to `>&2` so it lands in the container log below) | Ground truth: every instruction file that loads, with `load_reason` + `file_path` |
| **agent-runner stderr** | `groups/<group>/logs/container-<timestamp>.log` (written on container exit; also live at `LOG_LEVEL=debug` via the host logger) | The `[agent-runner] Additional directories: ...` line confirms which mounts were passed to the SDK |
| **Agent chat responses** | The group's chat channel directly | Whether the agent can actually *see* the `MARKER-MOUNT-*` strings |

> The tripwire is the authoritative source. The chat responses are a coarse confirmation; the container log confirms the mount was wired. Cross-check all three.

**Which group**: stated above — any group with a mount; `fin` recommended. The marker files go in whichever mount that group uses.

### Run A — `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` (current behaviour, baseline) — ✅ OBSERVED (2026-06-01)

- Spawn the container (send any message to the group).
- **Agent-testable**: Ask the agent: *"Without reading any files, repeat any text you see that starts with MARKER-MOUNT."* 
  - **Expected (baseline)**: agent echoes `MARKER-MOUNT-ROOT` (and `MARKER-MOUNT-IMPORT` if imports expand). This confirms eager loading is happening.

**Observations**: Agent echoed `MARKER-MOUNT-ROOT-A7X9Q2` at session start — confirmed eager loading of mount-root `CLAUDE.md`. `@import` did NOT expand (`MARKER-MOUNT-IMPORT` not visible). `sub/CLAUDE.md` not loaded. Tripwire hook fired but `$CLAUDE_HOOK_EVENT_DATA` env var was empty — agent response used as evidence instead.

### Run B — `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=0` (proposed behaviour) — ✅ OBSERVED (2026-06-01)

- Rebuild settings.json / respawn so the var is `0`.
- **Agent-testable (eager check)**: Same prompt: *"Without reading any files, repeat any text starting with MARKER-MOUNT."*
  - **Expected (hypothesis)**: agent sees **none** of the markers at session start.
- **Agent-testable (navigation check)**: Now ask: *"List the files in /workspace/extra and read one file inside the mount."* — drive the agent to navigate into the mount.
  - **Expected (hypothesis)**: `CLAUDE.md` does NOT auto-load on navigation — additional dirs are outside the cwd tree.

**Observations**: 
- Eager check: agent saw NO markers at session start. ✅ Hypothesis confirmed.
- Navigation check: agent navigated into `/workspace/extra/test-mount/`, explicitly read `imported.md`, and saw `MARKER-MOUNT-IMPORT-B3K8P5` — but only because it **read the file**. Mount-root `CLAUDE.md` was NOT auto-loaded on navigation. No `nested_traversal` load path triggered. ✅ Hypothesis confirmed.

### What each outcome means

| Observation in Run B | Interpretation | Action |
|---|---|---|
| No mount `CLAUDE.md` loads at session_start OR on navigation | Hypothesis confirmed — `=0` fully closes extra-mount auto-loading | Safe to disable the var; design host scanner as detect-layer for mount content |
| Loads on navigation (`nested_traversal`) | Residual lazy path exists for add-dirs | Do NOT rely on var alone; need watch/scan-before-navigate or block design |
| Loads via `include` (@import) even at `=0` | Import expansion independent of the var | Must follow @import in scanner; reconsider |

---

## Decision gate — ✅ RESOLVED (2026-06-01)

**Hypothesis holds.** `=0` fully closes extra-mount auto-loading with no residual navigation-time load path. Safe to disable `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`. Next step: design host-side independent scanner as a separate task. `container-runner.ts` reverted to `=1` pending that implementation task.

---

# Testing: Tool Governance & Live Config (v1.23.0)

Closes the nightly-nudge Bash bypass, moves tool resolution to a container-side allowlist-ceiling model, and makes group `containerConfig` (incl. `deniedTools`) live per-spawn across all three spawn paths.

**Prerequisite**: Switch the test group to `:next` channel (`/version next`).

---

## Agent-Testable (automated via chat)

### G1. Bash absent under approval mode (all paths) — ✅ PASSED (2026-06-01)

- **Group**: Any group with default config (`approvalMode` not explicitly `false`)
- **Test**: Ask the agent: "List all your available built-in tools"
- **Expected**: `Bash` does NOT appear. `mcp__nanoclaw__execute_command` is present.
- **Why**: Hard rule — Bash is stripped from the ceiling on every spawn path (live, scheduled, nightly nudge).

**Observations**: Covered by T2. No `Bash` tool present across all groups (all default to approval mode on).

### G2. Bash present when approval mode disabled — ⚠️ SKIPPED (2026-06-01)

- **Group**: A group with `approvalMode: false` in `containerConfig`
- **Test**: Ask the agent: "List all your available built-in tools"
- **Expected**: `Bash` IS present.
- **Why**: Hard rule only fires when `approvalMode !== false`.

**Observations**: No groups have `approvalMode: false` configured. Skipped — would require temporarily setting it in DB.

### G3. WebSearch/WebFetch absent by default — ✅ PASSED (2026-06-01)

- **Group**: Any group whose preset does NOT have `nativeWebTools: true`
- **Test**: Ask the agent: "Do you have WebSearch or WebFetch tools?"
- **Expected**: Neither appears. Web search goes through `mcp__nanoclaw-web-search__*`.
- **Why**: `nativeWebTools` defaults false; native web tools are Anthropic-hosted only.

**Observations**: Covered by T1. Native tools absent, MCP web search present.

### G4. deniedTools respected per-group — ✅ PASSED (2026-06-01)

- **Group**: A test group — add `"deniedTools": ["Edit", "Write"]` to its `containerConfig` in the DB (no restart needed)
- **Test**: Spawn a new container (send any message), then ask: "List your available built-in tools"
- **Expected**: `Edit` and `Write` do NOT appear. All other ceiling tools are present.
- **Cleanup**: Remove `deniedTools` from the group config after.

**Observations**: First attempt failed — stale container hadn't picked up the DB change. After `/shutdown` to force a fresh container, both `Edit` and `Write` were correctly blocked. Live config confirmed working on fresh spawn. Config cleaned up after.

### G5. Catalog correctness — no phantom tools — ✅ PASSED (2026-06-02, re-evaluated)

- **Group**: Any group
- **Test**: Ask the agent: "List all your available built-in tools"
- **Expected**: `RemoteTrigger`, `TodoWrite` do NOT appear. `Task` (= the subagent tool, see below), `Monitor`, `PushNotification`, `ScheduleWakeup` DO appear.

**Original observation (2026-06-01)**: The agent invoked a subagent via the `Agent` tool and this was flagged as a ceiling bypass, because `Agent` is not in `tool-allowlist.json` (only `Task` is).

**Re-evaluation (2026-06-02) — false alarm, not a bypass**: `Task` and `Agent` are the **same tool**. Per the [Agent SDK subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents), the subagent tool was renamed `Task` → `Agent` in Claude Code v2.1.63: current SDK releases emit `Agent` in `tool_use` blocks but **still use `Task` in the `system:init` tools list** (which is what `options.tools` filters against). So the ceiling gates it correctly under the name `Task` — the original tester saw the `Agent` invocation name, looked for `Agent` in the allowlist, didn't find it, and wrongly concluded a bypass.

**A/B confirmation**: On `testgroup_main` (v1.23.0/`:next`), set `containerConfig.deniedTools = ["Task"]`, forced a fresh container via `/shutdown`, then asked the agent to spawn a subagent. Result: the agent reported **no `Agent` tool present** and could not spawn — "the tool simply isn't in my function set." Denying `Task` removed the `Agent` capability, proving `Task` == `Agent` and that the ceiling does gate it. Config restored to `deniedTools: []` (verified byte-identical to pre-test backup) afterward. SDK in use: `@anthropic-ai/claude-agent-sdk@0.3.147` (TypeScript).

`RemoteTrigger` and `TodoWrite` correctly absent. `Monitor`, `PushNotification`, `ScheduleWakeup` correctly present.

**Caveat**: The post-deny check was via agent introspection, not a forced raw spawn attempt. This is consistent with the documented mechanism — a bare-name deny rule removes the tool definition from the request entirely, so the model cannot see or attempt it.

**Follow-up (optional, non-blocking)**: Consider adding a comment in `tool-allowlist.json` noting that the `Task` entry governs the subagent tool (surfaced to the model as `Agent`), so this naming mismatch doesn't trip up a future reviewer.

### G6. mcp__nanoclaw__* always present — ✅ PASSED (2026-06-01)

- **Group**: Any group, including one with a restrictive `deniedTools` list
- **Test**: Ask the agent: "What MCP tools do you have from the nanoclaw server?"
- **Expected**: IPC tools (`send_message`, `schedule_task`, etc.) are always available — they are never subject to the ceiling or `deniedTools`.

**Observations**: Confirmed present across all groups throughout testing. Never affected by any config changes.

---

## Human-Testable (requires manual observation)

### GM1. Live config — deniedTools takes effect without restart — ✅ PASSED (2026-06-01)

1. Pick a running group. Note its current tool list (ask the agent).
2. Edit `containerConfig.deniedTools` in the DB to add `["Glob"]`. **Do not restart the host.**
3. Send a new message to the group (spawns a fresh container).
4. Ask the agent: "Do you have the Glob tool?"
5. **Expected**: `Glob` is absent — config change was picked up live.
6. **Cleanup**: Remove `Glob` from `deniedTools`.

**Observations**: Tested with `["Edit", "Write"]` on `testgroup_main`. DB change picked up live on next fresh container spawn (no host restart). Both tools blocked correctly.

### GM2. Live config — tool-allowlist.json ceiling takes effect without restart — ✅ PASSED (2026-06-01)

1. Edit `repo/tool-allowlist.json` — remove `ToolSearch` from the `tools` array. **Do not restart the host.**
2. Send a new message to any group.
3. Ask the agent: "Do you have the ToolSearch tool?"
4. **Expected**: `ToolSearch` is absent.
5. **Cleanup**: Restore `ToolSearch` in `tool-allowlist.json`.

**Observations**: `ToolSearch` removed from ceiling, fresh container spawned — agent confirmed it had no `ToolSearch` tool and couldn't use it. `ToolSearch` restored after test.

### GM3. Nightly nudge no longer runs Bash (bypass closed) — ⏳ PENDING (check tomorrow)

- **Setup**: Enable verbose container logging (`LOG_LEVEL=debug`) and watch the container log for a group that has a nightly nudge scheduled.
- **Observation**: In the container log for the nudge spawn, the resolved `tools` array should NOT contain `Bash` (assuming `approvalMode` is active).
- **Why**: This was the live bypass — nudge was passing raw `allowedTools` including Bash. Now all 3 paths go through `resolveSpawnConfig`.

**Observations**: Bash fix landed today (2026-06-01). Check tomorrow's nudge container log for any group — confirm `Bash` absent from resolved tool set.

### GM4. Scheduled task path also gates Bash — ✅ PASSED (2026-06-01)

1. Schedule a task on a group with default `approvalMode`.
2. Let it fire (or advance `next_run` in the DB to trigger it immediately).
3. In the container log for the scheduled spawn, confirm `Bash` is absent from the resolved tool set.

**Observations**: Scheduled a task on `testgroup_main` via agent. Task fired in isolated context. Container log (`container-2026-06-01T19-04-32-209Z.log`, 20s duration, new session) shows no `Bash` in the log. Scheduled spawn path correctly gates Bash.

### GM5. Normal conversation unaffected — ✅ PASSED (2026-06-01)

- **Group**: `choc_main` (switch to `/version next`)
- **Test**: Send a normal message, verify the agent responds coherently with no missing capabilities.
- **Rollback**: `/version stable` if broken.

**Observations**: Covered by M1 — normal conversation confirmed working on `choc_main`.

---

## Promotion Checklist

After all tests pass:

```bash
cd repo/container
./scripts/container.sh promote v1.23.0
```

Then switch all groups back to stable: `/version stable`.
