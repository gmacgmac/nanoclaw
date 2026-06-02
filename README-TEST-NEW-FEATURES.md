# Testing: Dead allowedTools Removal (cleanup)

Validation plan for removing all dead `allowedTools` plumbing from the spawn pipeline. The ceiling-model resolution (`NANOCLAW_TOOL_ALLOWLIST` − `deniedTools` − hard rules) is unchanged — this change only removes the parallel dead path that was already a no-op.

**Context**: `allowedTools` was threaded through types, spawn-config, index, task-scheduler, container-runner, and agent-runner but never consumed by the agent-runner's resolution logic. Stale test suites (`computeDisallowedTools`/`ALL_KNOWN_TOOLS`) tested a model that no longer existed. All removed; ceiling-model tests added.

---

## Build/Test (automated)

### T1. TypeScript compiles clean (host + agent-runner) — ✅ PASS

- **Test**: `npx tsc --noEmit` from `repo/` (host) and `repo/container/agent-runner/` (agent-runner)
- **Expected**: Zero errors in both packages. No dangling references to `allowedTools` or `effectiveAllowedTools`.
- **Why**: Confirms no orphan references remain after source removal.

**Observations**: Both packages compile with exit code 0, zero errors. Grep confirms no dangling references to the removed dead path. Remaining `allowedTools` references are (a) the historical DB migration `002-deniedtools-migration.ts` and (b) the live ceiling-model resolution in `agent-runner/src/index.ts` which sets `options.allowedTools` for the SDK — both are correct and expected. (2026-06-02)

### T2. Full test suite green — ✅ PASS

- **Test**: `npx vitest run` from `repo/`
- **Expected**: All tests pass (936+ tests). No regressions.
- **Why**: Ensures removal didn't break anything and new ceiling-model tests are included.

**Observations**: 46 test files, 936 tests passed, 0 failures. Duration 5.84s. Exit code 0. (2026-06-02)

### T3. Ceiling-model resolution tests present — ✅ PASS

- **Test**: `npx vitest run src/tool-restrictions.test.ts` — look for "Ceiling-model tool resolution" describe block
- **Expected**: 14 cases pass covering: full ceiling passthrough, deniedTools removal, approvalMode→Bash removal, nativeWebTools→WebSearch/WebFetch removal, combined rules, mcp__nanoclaw__* always in allowedTools, fallback catalog on invalid/absent env, and harmless unknown deniedTools.
- **Why**: Replaces the stale `computeDisallowedTools` suite with real coverage of the live resolution model.

**Observations**: `src/tool-restrictions.test.ts` — 27 tests pass (includes the "Ceiling-model tool resolution" describe block plus related helper tests). Exit code 0. (2026-06-02)

---

## Agent-Testable (automated via chat)

### T4. Tool list unchanged for a default group (regression) — ✅ PASS

- **Group**: Any group with default config (`deniedTools: []`, `approvalMode` active, no `nativeWebTools`)
- **Test**: Ask the agent: "List all your available built-in tools"
- **Expected**: Identical tool set as before this change. The resolution behaviour is unchanged since `allowedTools` was already dead code (never read by the agent-runner).
- **Why**: Regression check — proves the removal had zero functional impact on tool availability.

**Observations**: Tested on `G Test` (preset OMM3, deniedTools: [], approvalMode default/active). Agent reports: Read, Write, Edit, Glob, Grep, NotebookEdit, Agent, TaskCreate/List/Get/Update/Output/Stop, CronCreate/Delete/List, ScheduleWakeup, EnterPlanMode/ExitPlanMode, EnterWorktree/ExitWorktree, AskUserQuestion, Skill, TeamCreate/TeamDelete, SendMessage, ToolSearch + MCP tools (execute_command, send_message, send_attachment, delegate_to_group, respond_to_group, get_registered_groups, ping, web_search, web_fetch, transcribe_audio, schedule_task/list/get/update/pause/resume/cancel/search). Consistent with ceiling model resolution. (2026-06-02)

### T5. deniedTools still takes effect on a fresh spawn — ✅ PASS

- **Group**: A test group — add `"deniedTools": ["Edit", "Write"]` to its `container_config` in the DB
- **Test**: Force a fresh container (`/shutdown` then send a message), ask: "List your available built-in tools"
- **Expected**: `Edit` and `Write` do NOT appear. All other ceiling tools are present.
- **Cleanup**: Remove `deniedTools` from the group config after.
- **Why**: Sanity check that the real governance path (ceiling model) is untouched.

**Observations**: Added `deniedTools: ["Edit", "Write"]` to G Test, forced fresh container via `/shutdown`. Agent confirmed: "No Edit and no Write either." Only NotebookEdit remains for file-related built-ins; Read, Glob, Grep, and all other ceiling tools still present. Reverted deniedTools to `[]` after test. (2026-06-02)

### T6. Bash absent under approval mode — ✅ PASS

- **Group**: Any group with default config (`approvalMode` not explicitly `false`)
- **Test**: Ask the agent: "Do you have the Bash tool?"
- **Expected**: `Bash` does NOT appear. `mcp__nanoclaw__execute_command` is present.
- **Why**: Hard rule in the ceiling model — Bash stripped when `approvalMode` is active.

**Observations**: Agent confirmed: "I do not have a Bash tool. The shell capability I have is execute_command (MCP)." Bash correctly stripped; MCP execute_command is the shell path. (2026-06-02)

### T7. WebSearch/WebFetch absent without nativeWebTools — ✅ PASS

- **Group**: Any group whose preset does NOT have `nativeWebTools: true`
- **Test**: Ask the agent: "Do you have WebSearch or WebFetch tools?"
- **Expected**: Neither appears. Web search goes through `mcp__nanoclaw-web-search__*`.
- **Why**: Native web tools only enabled when explicitly configured; MCP web search is the default path.

**Observations**: Agent lists `web_search` / `web_fetch` as MCP tools (nanoclaw-web-search server), not built-in `WebSearch`/`WebFetch`. Correct for a group without `nativeWebTools`. (2026-06-02)

---

## Human-Testable / DB

### T8. DB: allowedTools key absent after cleanup (DB_01) — ✅ PASS

- **Test**: After DB_01 completes, run:
  ```sql
  SELECT name, json_extract(container_config, '$.allowedTools') AS at
  FROM registered_groups;
  ```
- **Expected**: `at` column is NULL for all 6 groups. No `allowedTools` key exists in any `container_config` JSON.
- **Why**: Confirms the stale 25-item arrays are removed from the live DB.

**Observations**: All 6 groups (Choc, Shelley, G Test, Work, GM, Fin) return NULL for `allowedTools`. Verified via `json_each` key enumeration — `allowedTools` is absent from all groups' config JSON. (2026-06-02)

### T9. DB: all other container_config keys intact — ✅ PASS

- **Test**: After DB_01, for each group verify:
  ```sql
  SELECT name,
    json_extract(container_config, '$.preset') AS preset,
    json_extract(container_config, '$.skills') AS skills,
    json_extract(container_config, '$.deniedTools') AS denied,
    json_extract(container_config, '$.mcpServers') AS mcp
  FROM registered_groups;
  ```
- **Expected**: All existing keys (`preset`, `skills`, `deniedTools`, `mcpServers`, `additionalMounts`, `model`, `systemPrompt`, etc.) are intact and unchanged. Only `allowedTools` was removed.
- **Why**: Guards against accidental data loss during JSON key removal.

**Observations**: All groups retain their full key sets: `preset` (OK2.6), `skills` (group-specific arrays), `deniedTools` ([]), `mcpServers` (web-search + transcription), `telegramBot`, `allowedHostCommands`. Fin retains `additionalMounts`. No data loss. Key enumeration via `json_each` confirms only `allowedTools` was removed. (2026-06-02)

### T10. Normal conversation unaffected — ✅ PASS

- **Group**: `choc_main` or any active group
- **Test**: Send a normal message, verify the agent responds coherently
- **Expected**: Normal response, no errors, no missing capabilities
- **Why**: End-to-end sanity after all code and DB changes.

**Observations**: Tested on `testgroup`. `/model OMM3` switched successfully, agent responded coherently to conversational messages. No errors, no missing capabilities. (2026-06-02)

---

## Carryover from prior cycle

### GM3. Nightly nudge Bash-absent check — ⏳ BLOCKED (pre-deployment)

- **Setup**: Enable verbose container logging (`LOG_LEVEL=debug`) and watch the container log for a group that has a nightly nudge scheduled.
- **Observation**: In the container log for the nudge spawn, the resolved `tools` array should NOT contain `Bash` (assuming `approvalMode` is active).
- **Why**: The nightly-nudge path previously bypassed tool governance (passed raw `allowedTools` including Bash). Fixed in v1.23.0; this test confirms it holds.
- **Note**: This was `⏳ PENDING (check tomorrow)` in the prior cycle doc and was never marked as observed.

**Observations**: Checked June 1st logs. Midnight nudge fired but `groupsNudged: 0` — no groups were actually nudged. The 02:00 scheduled tasks were user-created cron tasks, not nudges. Those spawns still show the *old* "Passing allowedTools to container" log line (now removed in the cleanup), confirming the old code was still deployed on June 1st. Server is not currently running. **GM3 cannot be validated until after the cleanup is deployed and a nudge or scheduled task fires.** Mark for re-check post-deployment. (2026-06-02)

### Optional: tool-allowlist.json Task/Agent comment — ✅ DONE

- **Test**: Add a comment in `tool-allowlist.json` noting that the `Task` entry governs the subagent tool (surfaced to the model as `Agent`), so the naming mismatch doesn't trip up a future reviewer.
- **Why**: Follow-up from G5 investigation (2026-06-02) where `Task`/`Agent` naming confused a tester into thinking there was a ceiling bypass.
- **Status**: Optional, non-blocking.

**Observations**: Added `_taskNote` field explaining the Task→Agent naming convention. (2026-06-02)

---

## Execution Notes

- **T1–T3** are covered by VERIFY_01 (the next task in this sequence).
- **T4–T7** can be run after VERIFY_01 on any `:next` group.
- **T8–T9** are gated on DB_01 (the final task).
- **T10** should be run last, after DB_01.
- **GM3** requires waiting for a nightly nudge to fire (check logs the morning after deployment).
