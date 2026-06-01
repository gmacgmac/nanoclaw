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

### Run A — `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` (current behaviour, baseline)

- Spawn the container (send any message to the group).
- **Agent-testable**: Ask the agent: *"Without reading any files, repeat any text you see that starts with MARKER-MOUNT."* 
  - **Expected (baseline)**: agent echoes `MARKER-MOUNT-ROOT` (and `MARKER-MOUNT-IMPORT` if imports expand). This confirms eager loading is happening.
- **Observation**: tripwire log should show the mount-root `CLAUDE.md` with `load_reason: session_start`.

### Run B — `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=0` (proposed behaviour)

- Rebuild settings.json / respawn so the var is `0`.
- **Agent-testable (eager check)**: Same prompt: *"Without reading any files, repeat any text starting with MARKER-MOUNT."*
  - **Expected (hypothesis)**: agent sees **none** of the markers at session start. Tripwire log shows **no** extra-mount `CLAUDE.md` load at `session_start`.
- **Agent-testable (navigation check)**: Now ask: *"List the files in /workspace/extra and read one file inside the mount."* — drive the agent to navigate into the mount.
  - **Watch the tripwire**: does an extra-mount `CLAUDE.md` fire with `load_reason: nested_traversal` once the agent reads files there?
  - **Expected (hypothesis)**: it does NOT fire — additional dirs are outside the cwd tree, so the lazy nested-load path doesn't apply. **This is the key observation.**
  - **If it DOES fire**: we've found a residual load path; the env var alone is insufficient and we must handle navigation-time loading before disabling.

### What each outcome means

| Observation in Run B | Interpretation | Action |
|---|---|---|
| No mount `CLAUDE.md` loads at session_start OR on navigation | Hypothesis confirmed — `=0` fully closes extra-mount auto-loading | Safe to disable the var; design host scanner as detect-layer for mount content |
| Loads on navigation (`nested_traversal`) | Residual lazy path exists for add-dirs | Do NOT rely on var alone; need watch/scan-before-navigate or block design |
| Loads via `include` (@import) even at `=0` | Import expansion independent of the var | Must follow @import in scanner; reconsider |

---

## Direct-chat script (for the human driving the agent)

Run in the test group, once per env-var value:

1. "Repeat verbatim any text in your context that begins with `MARKER-MOUNT`. Do not read files — only what you already see."  → tests **eager** load
2. "Now list `/workspace/extra/` and read one file inside the mount." → triggers potential **navigation** load
3. "Again, repeat any text beginning with `MARKER-MOUNT` you can now see." → tests **post-navigation** load
4. Host-side: capture the `InstructionsLoaded` tripwire log for the session and attach to the observations.

## Decision gate

Only after Run A + Run B observations are recorded do we decide:
- **If hypothesis holds** → disable `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, then design the host-side independent scanner (watch-based vs. periodic; detect-only vs. detect+kill) as a separate task.
- **If a residual load path is found** → that path becomes the thing the new design must protect, before we disable anything.

> No production change lands from this doc. It is a validation experiment whose output feeds the real implementation task.
