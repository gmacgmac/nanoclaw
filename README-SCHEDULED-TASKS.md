# Scheduled Tasks

NanoClaw has a built-in scheduler that runs tasks as full agents inside the group's container. Tasks have access to all the same tools the group has (WebSearch, Bash, file operations, MCP servers). They can send messages back to the group, complete silently, or both.

This is separate from the nightly maintenance cron (`startNightlyCron` in `src/task-scheduler.ts`). Nightly maintenance is a fixed internal job and is not a row in `scheduled_tasks`. Scheduled tasks are user-created, stored in PostgreSQL, and managed via MCP tools.

---

## Scheduling Is Best-Effort

Scheduled tasks share the per-group queue slot with chat containers. A task fires **only when the group's slot is free**. If the group has an active container — whether mid-turn or idle-waiting — the task waits.

What can delay a task:

- An active chat container (idle or mid-turn) occupying the group's slot
- Other queued tasks ahead of it in `pendingTasks[]`
- The scheduler poll interval (up to 60s between checks)

This means a task scheduled for 09:00 might not fire until 09:01 or later if the group is busy. Tasks are **not real-time guarantees** — they are best-effort dispatches.

**Recommendations:**

- Schedule critical tasks for low-activity windows (e.g., early morning, late night)
- Don't have agents actively monitor task completion in real time — use `get_task` to check `last_run` and `last_result` after the fact
- For time-sensitive work, keep the group's chat container idle around the scheduled time

---

## Runtime State

Every active task has a live `runtime_state` field derived at request time from the `GroupQueue` and DB state. This field is **not persisted** — it reflects the current moment.

| Value | Meaning |
|-------|---------|
| `running` | Task is the currently executing task for its group |
| `queued` | Task is in the pending queue, waiting for the slot |
| `blocked` | Task is due but the group has an active container (chat or another task) |
| `due` | Task is due and the group has no active container (will be picked up next poll) |
| `idle` | Task is active but `next_run` is in the future |
| `null` | Task is `paused` or `completed` (no runtime concept) |

**Where it appears:**

- `list_tasks` — appended as `[running]`, `[queued]`, `[blocked]`, or `[due]` annotation (skips `idle`)
- `get_task` — shown as a `Runtime State: <value>` field

**Dashboard divergence:** `nanoclaw-dashboard` reads PostgreSQL directly and does NOT see `runtime_state`. The dashboard only shows persisted columns (`status`, `next_run`, `last_run`, etc.). This is documented divergence — plans for parity are out of scope.

---

## How the Scheduler Loop Works

`startSchedulerLoop()` in `src/task-scheduler.ts` polls `getDueTasks()` every 60 seconds (`SCHEDULER_POLL_INTERVAL` in `src/config.ts`). Due tasks are enqueued on the per-group queue — the same queue used for incoming messages — so they respect concurrency limits and don't race with live conversations.

For each due task, `runTask()`:

1. Inserts a `'started'` sentinel row into `task_run_logs` (survives crashes — see "Run Audit Trail")
2. Advances `next_run` to the next scheduled time **before** spawning the container (see "Metadata Update Timing")
3. Resolves the group folder. **If the group no longer exists** (e.g., it was removed via `setup/unregister.ts`), the task is **paused** (`status: 'paused'`) and the run is aborted. This prevents zombie retry loops where a task for a removed group fires every 60 seconds indefinitely.
4. Spawns a **fresh, dedicated task container** via `runContainerAgent()` with `isScheduledTask: true`. Tasks never reuse an existing chat container — every task run is its own `docker run --rm`.
5. Prepends `[SCHEDULED TASK - ...]` to the prompt inside the container so the agent knows the message is automated, not from a real user
6. Streams results back to the host; any text output is forwarded directly to the group's chat via `channel.sendMessage` (not piped through any other container — see "What you see in chat when a task fires" below)
7. After a result arrives, schedules a 10-second close delay (`TASK_CLOSE_DELAY_MS`) — tasks are single-turn, so there's no need to keep the container alive for the full idle timeout
8. Transitions the `'started'` log row to `'success'` or `'error'` and updates `last_run` / `last_result` via `updateTaskAfterCompletion()`

**Host schedules and dispatches. Container executes.** The host owns the loop; the agent always runs inside the group's container image with the group's full environment.

Nudges are disabled for scheduled tasks (`nudgeInterval: 0` when `isScheduledTask: true`).

---

## Metadata Update Timing

`next_run` is advanced **at the start of the run**, before the container spawns. This ensures that a host crash mid-run does not re-trigger the same task on restart.

`last_run` and `last_result` are written **after the task container exits**, via `updateTaskAfterCompletion()`.

For `once` tasks, `next_run` is set to `null` upfront. The `status` field flips to `completed` only on successful completion. If the host crashes mid-run, the task won't re-trigger (since `next_run` is already null), and the abandoned run is surfaced via the crash-recovery sweep (see "Run Audit Trail").

**During an in-flight run:**

- `get_task` and `list_tasks` show the **previous** run's `last_run` / `last_result` (not yet updated)
- `runtime_state` shows `running` (derived live from `GroupQueue`)
- The `task_run_logs` table has a `'started'` row for the current run (visible via `get_task` run history)

---

## Run Audit Trail

Every task run produces a row in `task_run_logs` that tracks its lifecycle:

| `status` value | Meaning |
|----------------|---------|
| `started` | Run is in-flight (sentinel inserted at the top of `runTask`) |
| `success` | Run completed successfully |
| `error` | Run failed (error message in `error` column) |

### Crash Recovery

If the host crashes or is killed mid-run, orphaned `'started'` rows remain in `task_run_logs`. On the next host startup, **before the scheduler loop begins**, a sweep runs:

1. `getOrphanedStartedRuns()` finds all rows still in `'started'` status
2. Each is closed out as `status: 'error', error: 'Host stopped mid-run', duration_ms: 0`
3. One aggregated alert is sent per affected group: `⚠️ N task run(s) abandoned during last shutdown:` followed by the task labels

Because `next_run` was already advanced at run start (see above), the abandoned task will **not** re-trigger. The user sees the alert and can re-create or re-schedule if needed.

---

## Graceful Shutdown

When the host receives `SIGTERM` or `SIGINT`, it performs a graceful shutdown sequence:

1. **Stops the scheduler loop** — no new tasks will be enqueued
2. **Closes the proxy** — no new requests accepted
3. **Writes `_close` to all active containers** — signals them to finish and exit
4. **Waits up to `SHUTDOWN_GRACE_MS`** (default 30s) for all containers to exit naturally
5. **Disconnects channels and exits** — `process.exit(0)`

If containers are still running when the grace period expires, the host exits anyway. Those runs become orphaned `'started'` rows, handled by the crash-recovery sweep on next startup.

**Double-signal escape:** A second `SIGINT` during the grace period triggers `process.exit(1)` immediately — useful when you need to force-quit without waiting.

---

## Concurrency: Chat vs Task Containers

Each registered group has its own slot on the `GroupQueue` (`src/group-queue.ts`). Per group, **only one container can run at a time** — chat and task containers never coexist for the same group. Different groups run in parallel up to `MAX_CONCURRENT_CONTAINERS`.

### Two flows, one slot per group

| Flow | Container | Lifetime | Trigger |
|------|-----------|----------|---------|
| **Chat** | Long-lived (`isTaskContainer: false`) | Lives until idle for `IDLE_TIMEOUT` ms with no streamed result. Each new user message is piped into the running SDK query via IPC, resetting the timer. Hard cap is `CONTAINER_TIMEOUT`, also reset on every result. | User message arrives via Telegram/Dashboard |
| **Task** | Single-shot (`isTaskContainer: true`) | Spawns fresh per task, closed via `_close` sentinel ~10s after the agent emits its first result | Scheduler loop finds a due task |

### What happens when both want to run

If a task fires while a chat container is active:

1. `enqueueTask` sees `state.active === true` → pushes the task into `pendingTasks[]`
2. If the chat is `idleWaiting` (finished its last response, waiting for IPC input), the queue **immediately preempts** by writing `_close` to the chat container
3. If the chat is still mid-turn (streaming results), the task waits until the turn completes and the chat goes idle, then `_close` is written
4. Chat container exits → `drainGroup()` runs → tasks are prioritised over pending messages → fresh task container spawns

Symmetrically, user messages that arrive while a task is running are queued (`pendingMessages` flag) and handled in a fresh chat container after the task exits. The host's `queue.sendMessage` explicitly **refuses** to pipe user text into a task container (`if (state.isTaskContainer) return false`), so a user can never inject into a running task.

A host crash mid-run is safe: `next_run` was already advanced upfront, so the task won't re-trigger on restart. The orphaned run is detected and reported by the crash-recovery sweep.

### Implication for testing

If you want to test a task firing live: leave the chat container alone (or wait for it to idle out) so the task can preempt and run. The chat container will respawn for your next message after the task completes.

### Per-group queue with dedup

`GroupQueue.groups` is a `Map<groupJid, GroupState>`. `enqueueTask` deduplicates by task ID — the same task ID will not double-queue:

- Rejected if `state.runningTaskId === taskId` (already running)
- Rejected if `state.pendingTasks.some(t => t.id === taskId)` (already queued)

Different task IDs queue freely, drained FIFO. There is no length cap on `pendingTasks[]`.

---

## What you see in chat when a task fires

When a task produces output, you'll see a message in the group chat moments later. **This is not the chat agent reacting to a notification.** No second container spawns.

The flow is direct:

1. Task container's agent emits its result via the OUTPUT marker stream
2. `runTask()`'s streaming callback receives the result and calls `deps.sendMessage(task.chat_jid, result)`
3. `deps.sendMessage` (wired in `src/index.ts`) calls `channel.sendMessage` directly — Telegram/Dashboard delivers it
4. 10s later, `_close` is written → task container exits → metadata is updated

The "reply" you see is the task agent's own final output, shipped straight to the channel by the host. The chat container is uninvolved (and during this window, it isn't running for that group anyway).

---

## Configuration

All timing and capacity values are configurable via `.env` or environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `IDLE_TIMEOUT` | `1800000` (30 min) | How long a chat container stays alive after its last streamed result |
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Hard-kill safety net for any container. Resets on every streamed result |
| `SCHEDULER_POLL_INTERVAL` | `60000` (60s) | How often the scheduler checks for due tasks (hardcoded in `config.ts`) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Maximum containers running across all groups simultaneously |
| `SHUTDOWN_GRACE_MS` | `30000` (30s) | How long graceful shutdown waits for in-flight containers before hard exit |

**Not env-configurable (hardcoded constants):**

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `TASK_CLOSE_DELAY_MS` | `10000` (10s) | `src/task-scheduler.ts` | Delay after task result before writing `_close` |
| `SCHEDULER_POLL_INTERVAL` | `60000` (60s) | `src/config.ts` | Scheduler tick interval |

---

## Schedule Types

Three types are supported. All times use the `TIMEZONE` setting from `src/config.ts` (used by `cron-parser` and `substitutePromptVars()`).

| Type | `schedule_value` format | Behaviour |
|------|------------------------|-----------|
| `cron` | Standard cron expression | Parsed via `cron-parser`. Recurs on the cron schedule. Next run computed from `CronExpressionParser.parse()`. |
| `interval` | Positive integer (milliseconds) as a string | Anchored to the scheduled time, not `Date.now()` — avoids drift. Skips missed intervals so next run is always in the future. |
| `once` | Local ISO timestamp, **no `Z` suffix** | Runs once. After the run, `next_run` is set to `null` and the task status becomes `completed`. |

**`once` format is strict.** The API rejects any value with a `Z` suffix or a UTC offset (`+00:00` etc.). Use bare local time:

```
✓  2026-06-01T15:30:00
✗  2026-06-01T15:30:00Z      ← rejected
✗  2026-06-01T15:30:00+01:00 ← rejected
```

Validation happens inside `schedule_task` in `container/agent-runner/src/ipc-mcp-stdio.ts` before the IPC file is written, so the agent gets an error back immediately rather than creating a broken task.

---

## Context Mode

Each task has a `context_mode` that controls whether it runs against the group's live conversation history.

| `context_mode` | Session used | When to use |
|----------------|-------------|-------------|
| `group` | Resumes the group's current `.jsonl` session | Task needs conversation context — "follow up on what I asked", preference recall, referencing recent decisions |
| `isolated` | Fresh session, no conversation history | Self-contained tasks — daily reports, reminders, background data gathering. **Put all necessary context in the prompt itself.** |

**There is no default.** The agent must always ask the user which mode to use before scheduling a task. The `schedule_task` schema has no `.default()` — omitting `context_mode` will fail validation.

The agent is instructed to ask in plain language: *"Should this task remember our past chats when it runs, or start fresh each time?"*

`context_mode` is stored in the `scheduled_tasks` table. It was added as a migration (`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'` in `src/db.ts`), so existing tasks (created before this change) default to `isolated`.

---

## Prompt Placeholders

Placeholders are substituted at run time (just before the container spawns), not at creation time. This matters for `isolated` mode tasks where the agent has no conversation context to infer the current date.

Substitution is done by `substitutePromptVars()` in `src/task-scheduler.ts`.

| Placeholder | Example output |
|-------------|---------------|
| `{{NOW}}` | `Tuesday, 2026-05-21 09:00:00` |
| `{{DATETIME}}` | `2026-05-21T09:00:00` |
| `{{DATE}}` | `2026-05-21` |
| `{{TIME}}` | `09:00:00` |
| `{{DAY_OF_WEEK}}` | `Tuesday` |

Example: `"It's {{NOW}}. Search Hacker News for today's top AI stories and send a summary to the group."`

---

## MCP Tools (Agent-Facing)

These are registered on the `nanoclaw` MCP server in `container/agent-runner/src/ipc-mcp-stdio.ts`. All read and mutation tools use a request/response IPC pattern: the container writes a `.req.json` file to `/workspace/ipc/tasks/`, the host processes it and writes a `.resp.json` file back. This means agents always see fresh data — there is no stale snapshot.

| Tool | Purpose | Scope |
|------|---------|-------|
| `schedule_task` | Create a new task | Own-group default; main can target other groups via `target_group_jid` |
| `list_tasks` | List tasks with description + 50-char prompt preview | Own-group only |
| `get_task` | Get full single-task detail (all fields, run history) | Own-group only |
| `search_tasks` | Keyword/regex search across description, prompt, and script | Own-group only |
| `update_task` | Modify prompt, schedule, or description (get → modify → replace) | Own-group only |
| `pause_task` | Pause a task | Own-group only |
| `resume_task` | Resume a paused task | Own-group only |
| `cancel_task` | Delete a task and its run logs | Own-group only |

**`schedule_task` parameters of note:**

- `description` — **required**. Human-readable summary of what the task does (shown in `list_tasks` output)
- `schedule_type` — `cron`, `interval`, or `once`
- `schedule_value` — format per schedule type (see above)
- `context_mode` — `group` or `isolated` (required — agent must ask the user)
- `target_group_jid` — (main only) JID of the target group; defaults to current group
- `prompt` — supports `{{NOW}}` etc. placeholders

---

## Visibility Rules

A clear summary of who can see and do what:

**Read tools** (`list_tasks`, `get_task`, `search_tasks`):
- Own-group only, always. No exceptions for main.

**Mutation tools** (`pause_task`, `resume_task`, `cancel_task`, `update_task`):
- Own-group only, always. No exceptions for main.

**Creation tool** (`schedule_task`):
- Own-group by default.
- Main can target other groups via `target_group_jid`.

This means a non-main agent can only ever interact with tasks that belong to its own group. A main agent can *create* tasks in other groups but cannot subsequently see, update, or cancel them through these tools (see Orphan Tasks below).

---

## Main vs Non-Main: Authorization Model

The `isMain` flag on `registered_groups` determines what a group's agent can do with scheduled tasks. This is the **single most important security boundary** for task management — main is your privileged control room, everything else is sandboxed to itself.

### Where `isMain` Comes From

- Set **once** at registration time via `--is-main` flag in `setup/register.ts:66-67`
- Stored in `registered_groups.is_main` column (`src/db.ts:654, 675, 710`)
- **Cannot be changed by agents via IPC** — `src/ipc.ts` explicitly preserves `existingGroup?.isMain` when an agent calls `register_group`, ignoring any `isMain` value in the payload (defense in depth)

> **Note on `register_group` gating**: The `register_group` capability is gated on `is_admin` (not `is_main`). Only the admin group (registered with `--is-admin`) can register new groups. The admin group also carries `is_main=1` — admin is a superset of main.

### Authorization Enforcement — Two Layers

**Layer 1: Container preflight (UX convenience)**

The agent-runner reads `NANOCLAW_IS_MAIN === '1'` from env (`container/agent-runner/src/ipc-mcp-stdio.ts`) and uses it to gate the `target_group_jid` parameter in `schedule_task`. If a non-main agent tries to pass `target_group_jid`, the MCP tool returns an error immediately without writing an IPC file.

This is **not** the real security check — it's a fast-fail UX improvement so agents get feedback before the round-trip to the host.

**Layer 2: Host-side verification (actual security boundary)**

When the host reads an IPC file from `/workspace/ipc/tasks/`, it determines the caller's identity by **which group's IPC directory the file came from** (`src/ipc.ts`). The `isMain` flag is read from the `registered_groups` table for that folder.

### Capability Matrix

| Capability | Main | Non-Main |
|------------|------|----------|
| **Schedule a task for own group** | ✓ | ✓ |
| **Schedule a task for another group** | ✓ (via `target_group_jid`) | ✗ |
| **List / get / search tasks** | Own-group only | Own-group only |
| **Pause / resume / cancel / update tasks** | Own-group only | Own-group only |

Note: main has **no cross-group visibility or mutation privileges** for read and mutation tools. The only cross-group capability is task creation via `schedule_task`.

### Orphan Tasks (Known Limitation)

When main creates a task in another group via `target_group_jid`, that task becomes an **orphan** from main's perspective:

- Main **cannot** see the task via `list_tasks`, `get_task`, or `search_tasks` (those tools only return own-group tasks)
- Main **cannot** update, pause, resume, or cancel the task
- Only the target group's agent can see and manage the task

**Recommendation:** Have the target group's agent own its tasks. Use main's cross-group scheduling only for bootstrapping — e.g., scheduling an initial task that the target group's agent will then manage itself.

Future admin tooling will close this gap by providing a separate privileged interface for cross-group task management with audit trails.

### Example: Non-Main Tries to Pause Main's Task

1. Non-main agent (`telegram_research`) calls `pause_task` with `task_id: "task-abc123"` (a task owned by `telegram_main`)
2. Container preflight: passes (no cross-group check for pause — only for `schedule_task` targeting)
3. IPC request file written to `/workspace/ipc/tasks/`
4. Host reads the file from `data/ipc/telegram_research/tasks/` → caller identity is `telegram_research`, `isMain = false`
5. Host looks up `task-abc123` → `task.group_folder = "telegram_main"`
6. Authorization check: `task.group_folder === sourceGroup` → `"telegram_main" === "telegram_research"` → **FAIL**
7. Host returns an error response to the container

### Example: Main Schedules a Task for Another Group

1. Main agent (`telegram_main`) calls `schedule_task` with `target_group_jid: "tg:-1001234567890"` (the `telegram_research` group)
2. Container preflight: passes (`isMain === true`)
3. IPC file written with `targetJid: "tg:-1001234567890"`
4. Host reads from `data/ipc/telegram_main/tasks/` → caller is main, `isMain = true`
5. Host resolves `targetJid` to `telegram_research` folder
6. Authorization check: `isMain || targetFolder === sourceGroup` → `true || ...` → **PASS**
7. Task created with `group_folder = "telegram_research"`, `chat_jid = "tg:-1001234567890"`
8. When the task runs, it spawns the `telegram_research` container and sends output to that group's chat
9. **Main can no longer see or manage this task** — only `telegram_research` can

### Why This Matters

Without this enforcement, any group could:
- Schedule tasks that run in another group's context (access to that group's memory, files, secrets)
- Cancel another group's scheduled reminders or maintenance tasks
- Spam another group's chat by scheduling tasks with `send_message`

The `isMain` boundary ensures only the designated control group (typically your personal self-chat) can orchestrate across groups. All other groups are isolated to their own task namespace.

---

## The `script` Field

The `scheduled_tasks` table has a `script` column (added in a migration alongside `context_mode`). It is stored, passed through `ContainerInput`, and searchable via `search_tasks`.

**Current status: plumbed but not implemented.** The `script` field is stored in the DB and forwarded to the agent-runner via `ContainerInput.script`, but `main()` in `container/agent-runner/src/index.ts` does not currently read or act on it. The field exists in the schema as a reserved slot for a future feature — likely to allow a task to carry an executable script alongside its natural-language prompt, rather than embedding procedural instructions in the prompt text.

If you set `script` today (e.g. via direct DB manipulation), it has no effect on task execution. Don't rely on it until this is implemented and documented here.

---

## Storage

Tasks are stored in PostgreSQL — Docker volume `pgdata`, container `nanoclaw-postgres-1`.

**`scheduled_tasks` table** — key columns:

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `task-{timestamp}-{random}` |
| `group_folder` | TEXT | e.g. `telegram_main` |
| `chat_jid` | TEXT | The group's JID (used for `sendMessage` and container dispatch) |
| `description` | TEXT | Human-readable task summary. Required by `schedule_task` MCP schema. Nullable for legacy rows (pre-migration). |
| `prompt` | TEXT | The agent's instruction. May contain `{{placeholders}}`. |
| `schedule_type` | TEXT | `cron`, `interval`, or `once` |
| `schedule_value` | TEXT | Raw value as provided |
| `context_mode` | TEXT | `group` or `isolated`. Required at creation time (no app-level default). DB migration default is `isolated` for pre-existing rows. |
| `next_run` | TEXT | ISO timestamp. `null` for completed `once` tasks. Advanced at run start. |
| `last_run` | TEXT | ISO timestamp of last execution |
| `last_result` | TEXT | First 200 chars of last result, or error message |
| `status` | TEXT | `active`, `paused`, `completed` |
| `script` | TEXT | Reserved — not yet implemented (see above) |
| `created_at` | TEXT | ISO timestamp |

**`task_run_logs` table** — execution history per task:

| Column | Notes |
|--------|-------|
| `task_id` | FK → `scheduled_tasks.id` |
| `run_at` | ISO timestamp |
| `duration_ms` | Wall time for the container run |
| `status` | `started`, `success`, or `error` |
| `result` | Full result text (nullable) |
| `error` | Error message if failed (nullable) |

A row in `started` status means the run is either in-flight or was abandoned (see "Run Audit Trail"). The crash-recovery sweep on host startup closes orphaned `started` rows.

`deleteTask()` in `src/db.ts` deletes child `task_run_logs` rows first (FK constraint), then the task row.

---

## Task Lifecycle: Creation and Container Visibility

### How Tasks Are Created

Tasks originate from one of two paths:

1. **Agent-initiated (normal flow):** An agent inside a container calls the `schedule_task` MCP tool (registered in `container/agent-runner/src/ipc-mcp-stdio.ts`). This writes a JSON IPC file to `/workspace/ipc/tasks/` inside the container, which maps to `data/ipc/{groupFolder}/tasks/` on the host. The host's `processTaskIpc()` in `src/ipc.ts` picks up the file, validates authorization (see Main vs Non-Main section above), and calls `createTask()` in `src/db.ts` to insert a row into the `scheduled_tasks` table in PostgreSQL.

2. **Direct DB manipulation (admin/debug only):** You can insert rows directly via psql (`docker compose exec postgres psql -U nanoclaw nanoclaw`). This bypasses all authorization checks and is only appropriate for debugging or migration scripts.

In both cases, the canonical store is always the PostgreSQL database. There is no file-based task storage.

### How Tasks Are Read by Agents (Request/Response IPC)

Agents cannot query the PostgreSQL database directly — it lives on the host, outside the container. Instead, task visibility works through request/response IPC:

1. Agent calls a read tool (`list_tasks`, `get_task`, `search_tasks`)
2. The MCP tool writes a `.req.json` file to `/workspace/ipc/tasks/` with a correlation ID
3. The host's `processTaskIpcRequest()` picks up the request, queries the database (filtered to the calling group), and writes a `.resp.json` file with the same correlation ID
4. The container polls for the response file (5-second timeout) and returns the result to the agent

This means:
- Data is always **fresh** — every read tool queries the live database
- There is no stale snapshot; agents see changes immediately
- The host enforces group isolation at query time (`getTasksForGroup(sourceGroup)`)
- Run history (`task_run_logs`) is accessible via `get_task` for own-group tasks
- `runtime_state` is derived live from `GroupQueue` at response time (see "Runtime State")

### The Full Round-Trip

```
Agent calls schedule_task MCP tool
  → container validates params (preflight)
  → writes JSON to /workspace/ipc/tasks/{timestamp}-{uuid}.json
  → host's processTaskIpc() reads the file from data/ipc/{group}/tasks/
  → host checks authorization (isMain || own group for target)
  → host calls createTask() → INSERT into scheduled_tasks table
  → task is now in PostgreSQL, scheduler loop will pick it up when due

Agent calls list_tasks MCP tool
  → writes .req.json with correlation ID to /workspace/ipc/tasks/
  → host's processTaskIpcRequest() reads the request
  → host queries getTasksForGroup(sourceGroup) — own-group only
  → host derives runtime_state for each task from GroupQueue
  → host writes .resp.json with results (including runtime_state annotations)
  → container reads response, returns formatted task list to agent
```

---

## Key Source Files

| File | Role |
|------|------|
| `src/task-scheduler.ts` | Scheduler loop, `runTask()`, `computeNextRun()`, `substitutePromptVars()`, `stopSchedulerLoop()`, nightly cron |
| `src/task-runtime-state.ts` | `deriveRuntimeState()` — pure helper for live runtime state derivation |
| `src/abandoned-run-sweep.ts` | `sweepAbandonedRuns()` — startup sweep for orphaned `started` rows + alert dispatch |
| `src/ipc.ts` → `processTaskIpc()` | Host-side authorization and task CRUD from container IPC files |
| `src/ipc.ts` → `processTaskIpcRequest()` | Host-side request/response handler for read tools (decorates with `runtime_state`) |
| `src/db.ts` | `createTask`, `getDueTasks`, `updateTask`, `updateTaskAfterCompletion`, `deleteTask`, `logTaskRunStarted`, `updateTaskRunLog`, `getOrphanedStartedRuns`, `getTasksForGroup` |
| `src/group-queue.ts` | Per-group queue, `shutdown(gracePeriodMs)`, `isTaskRunning()`, `isTaskQueued()`, `hasActiveContainer()` |
| `src/config.ts` | `SCHEDULER_POLL_INTERVAL`, `SHUTDOWN_GRACE_MS`, `IDLE_TIMEOUT`, `CONTAINER_TIMEOUT`, `TIMEZONE` |
| `src/index.ts` | Startup wiring (sweep → scheduler), shutdown handler (stop loop → close → grace wait) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `schedule_task` and all task management MCP tools (annotates `runtime_state` in output) |
