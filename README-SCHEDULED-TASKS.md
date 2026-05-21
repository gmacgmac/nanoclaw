# Scheduled Tasks

NanoClaw has a built-in scheduler that runs tasks as full agents inside the group's container. Tasks have access to all the same tools the group has (WebSearch, Bash, file operations, MCP servers). They can send messages back to the group, complete silently, or both.

This is separate from the nightly maintenance cron (`startNightlyCron` in `src/task-scheduler.ts`). Nightly maintenance is a fixed internal job and is not a row in `scheduled_tasks`. Scheduled tasks are user-created, stored in SQLite, and managed via MCP tools.

---

## How the Scheduler Loop Works

`startSchedulerLoop()` in `src/task-scheduler.ts` polls `getDueTasks()` every 60 seconds (`SCHEDULER_POLL_INTERVAL` in `src/config.ts`). Due tasks are enqueued on the per-group queue — the same queue used for incoming messages — so they respect concurrency limits and don't race with live conversations.

For each due task, `runTask()`:

1. Resolves the group folder and writes a tasks snapshot for the container (`writeTasksSnapshot()`)
2. Spawns the group's container via `runContainerAgent()` with `isScheduledTask: true`
3. Prepends `[SCHEDULED TASK - ...]` to the prompt inside the container so the agent knows the message is automated, not from a real user
4. Streams results back to the host; any text output is forwarded to the group's chat via `sendMessage`
5. After a result arrives, schedules a 10-second close delay (`TASK_CLOSE_DELAY_MS`) — tasks are single-turn, so there's no need to keep the container alive for the full idle timeout (30 min)
6. Logs the run to `task_run_logs` and updates `next_run` and `last_result` via `updateTaskAfterRun()`

**Host schedules and dispatches. Container executes.** The host owns the loop; the agent always runs inside the group's container image with the group's full environment.

Nudges are disabled for scheduled tasks (`nudgeInterval: 0` when `isScheduledTask: true`).

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

Default is `isolated`. If unclear, the agent should ask: "follow up on our discussion" → `group`; "check Hacker News every morning" → `isolated`.

`context_mode` is stored in the `scheduled_tasks` table. It was added as a migration (`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'` in `src/db.ts`), so existing tasks default to `isolated`.

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

These are registered on the `nanoclaw` MCP server in `container/agent-runner/src/ipc-mcp-stdio.ts`. Agents write IPC files to `/workspace/ipc/tasks/`; the host's `processTaskIpc()` in `src/ipc.ts` consumes and authorizes them.

| Tool | Purpose |
|------|---------|
| `schedule_task` | Create a new task |
| `list_tasks` | List tasks |
| `get_task` | Get task details and run history |
| `update_task` | Modify prompt or schedule |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task and its run logs |

**`schedule_task` parameters of note:**

- `schedule_type` — `cron`, `interval`, or `once`
- `schedule_value` — format per schedule type (see above)
- `context_mode` — `group` or `isolated` (default `isolated`)
- `target_group_jid` — (main only) JID of the target group; defaults to current group
- `prompt` — supports `{{NOW}}` etc. placeholders

---

## Main vs Non-Main: Authorization Model

The `isMain` flag on `registered_groups` determines what a group's agent can do with scheduled tasks. This is the **single most important security boundary** for task management — main is your privileged control room, everything else is sandboxed to itself.

### Where `isMain` Comes From

- Set **once** at registration time via `--is-main` flag in `setup/register.ts:66-67`
- Stored in `registered_groups.is_main` column (`src/db.ts:654, 675, 710`)
- **Cannot be changed by agents via IPC** — `src/ipc.ts:732-744` explicitly preserves `existingGroup?.isMain` when an agent calls `register_group`, ignoring any `isMain` value in the payload (defense in depth)

### Authorization Enforcement — Two Layers

**Layer 1: Container preflight (UX convenience)**

The agent-runner reads `NANOCLAW_IS_MAIN === '1'` from env (`container/agent-runner/src/ipc-mcp-stdio.ts:23`) and uses it to gate the `target_group_jid` parameter in `schedule_task` and similar tools. If a non-main agent tries to pass `target_group_jid`, the MCP tool returns an error immediately without writing an IPC file.

This is **not** the real security check — it's a fast-fail UX improvement so agents get feedback before the round-trip to the host.

**Layer 2: Host-side verification (actual security boundary)**

When the host reads an IPC file from `/workspace/ipc/tasks/`, it determines the caller's identity by **which group's IPC directory the file came from** (`src/ipc.ts:447`). The `isMain` flag is read from the `registered_groups` table for that folder.

Every task operation checks authorization against this verified identity:

| Operation | Authorization Check | Code Location |
|-----------|-------------------|---------------|
| `schedule_task` for another group | `isMain \|\| targetFolder === sourceGroup` | `src/ipc.ts:486-493` |
| `pause_task` | `isMain \|\| task.group_folder === sourceGroup` | `src/ipc.ts:563` |
| `resume_task` | `isMain \|\| task.group_folder === sourceGroup` | `src/ipc.ts:582` |
| `cancel_task` | `isMain \|\| task.group_folder === sourceGroup` | `src/ipc.ts:601` |
| `update_task` | `isMain \|\| task.group_folder === sourceGroup` | `src/ipc.ts:627-633` |

If authorization fails, the host logs a warning and **silently ignores the IPC file**. No error is sent back to the container — the agent just doesn't see the expected result.

### What Main Can Do That Non-Main Cannot

| Capability | Main | Non-Main | Enforcement |
|------------|------|----------|-------------|
| **Schedule a task for another group** | ✓ Any group | ✗ Own group only | `src/ipc.ts:486-493` — checks `targetFolder === sourceGroup` |
| **Pause another group's task** | ✓ Any task | ✗ Own tasks only | `src/ipc.ts:563` — checks `task.group_folder === sourceGroup` |
| **Resume another group's task** | ✓ Any task | ✗ Own tasks only | `src/ipc.ts:582` |
| **Cancel another group's task** | ✓ Any task | ✗ Own tasks only | `src/ipc.ts:601` |
| **Update another group's task** | ✓ Any task | ✗ Own tasks only | `src/ipc.ts:627-633` |
| **See all tasks in `list_tasks`** | ✓ All groups | ✗ Own group only | `src/container-runner.ts:830-833` — `writeTasksSnapshot()` filters before container spawn |
| **See task details via `get_task`** | ✓ Any task | ✗ Own tasks only | Container reads pre-filtered snapshot |

### Snapshot Filtering (Pre-Container)

The host writes a filtered tasks snapshot to `/workspace/ipc/current_tasks.json` **before** the container spawns (`src/container-runner.ts:830-833` in `writeTasksSnapshot()`):

```typescript
const filteredTasks = isMain
  ? tasks
  : tasks.filter((t) => t.groupFolder === groupFolder);
```

This means:
- Main's container sees **all tasks from all groups** in the snapshot
- Non-main's container sees **only its own group's tasks**

When a non-main agent calls `list_tasks` or `get_task`, it's reading from this pre-filtered file. There's no way for a non-main agent to see another group's tasks — the data never enters its container.

### Example: Non-Main Tries to Pause Main's Task

1. Non-main agent (`telegram_research`) calls `mcp__nanoclaw__pause_task` with `task_id: "task-abc123"` (a task owned by `telegram_main`)
2. Container preflight: passes (no cross-group check for pause — only for `schedule_task` targeting)
3. IPC file written to `/workspace/ipc/tasks/1234567890-abcdef.json`
4. Host reads the file from `data/ipc/telegram_research/tasks/` → caller identity is `telegram_research`, `isMain = false`
5. Host looks up `task-abc123` → `task.group_folder = "telegram_main"`
6. Authorization check at `src/ipc.ts:563`: `isMain || task.group_folder === sourceGroup` → `false || "telegram_main" === "telegram_research"` → **FAIL**
7. Host logs: `{ taskId: "task-abc123", sourceGroup: "telegram_research" }, "Unauthorized task pause attempt"`
8. IPC file is ignored, task remains active

The agent never gets an error response — it just doesn't see the task change state when it calls `list_tasks` next.

### Example: Main Schedules a Task for Another Group

1. Main agent (`telegram_main`) calls `schedule_task` with `target_group_jid: "tg:-1001234567890"` (the `telegram_research` group)
2. Container preflight: passes (`isMain === true`)
3. IPC file written with `targetJid: "tg:-1001234567890"`
4. Host reads from `data/ipc/telegram_main/tasks/` → caller is main, `isMain = true`
5. Host resolves `targetJid` to `telegram_research` folder
6. Authorization check at `src/ipc.ts:486-493`: `isMain || targetFolder === sourceGroup` → `true || ...` → **PASS**
7. Task created with `group_folder = "telegram_research"`, `chat_jid = "tg:-1001234567890"`
8. When the task runs, it spawns the `telegram_research` container and sends output to that group's chat

### Why This Matters

Without this enforcement, any group could:
- Schedule tasks that run in another group's context (access to that group's memory, files, secrets)
- Cancel another group's scheduled reminders or maintenance tasks
- Spam another group's chat by scheduling tasks with `send_message`

The `isMain` boundary ensures only the designated control group (typically your personal self-chat) can orchestrate across groups. All other groups are isolated to their own task namespace.

---

## The `script` Field

The `scheduled_tasks` table has a `script` column (added in a migration alongside `context_mode`). It is stored, passed through `ContainerInput`, and included in the tasks snapshot written to the container.

**Current status: plumbed but not implemented.** The `script` field is stored in the DB and forwarded to the agent-runner via `ContainerInput.script`, but `main()` in `container/agent-runner/src/index.ts` does not currently read or act on it. The field exists in the schema as a reserved slot for a future feature — likely to allow a task to carry an executable script alongside its natural-language prompt, rather than embedding procedural instructions in the prompt text.

If you set `script` today (e.g. via direct DB manipulation), it has no effect on task execution. Don't rely on it until this is implemented and documented here.

---

## Storage

Tasks are stored in `store/messages.db`.

**`scheduled_tasks` table** — key columns:

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `task-{timestamp}-{random}` |
| `group_folder` | TEXT | e.g. `telegram_main` |
| `chat_jid` | TEXT | The group's JID (used for `sendMessage` and container dispatch) |
| `prompt` | TEXT | The agent's instruction. May contain `{{placeholders}}`. |
| `schedule_type` | TEXT | `cron`, `interval`, or `once` |
| `schedule_value` | TEXT | Raw value as provided |
| `context_mode` | TEXT | `group` or `isolated` (default `isolated`) |
| `next_run` | TEXT | ISO timestamp. `null` for completed `once` tasks. |
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
| `status` | `success` or `error` |
| `result` | Full result text (nullable) |
| `error` | Error message if failed (nullable) |

`deleteTask()` in `src/db.ts` deletes child `task_run_logs` rows first (FK constraint), then the task row.

---

## Key Source Files

| File | Role |
|------|------|
| `src/task-scheduler.ts` | Scheduler loop, `runTask()`, `computeNextRun()`, `substitutePromptVars()`, nightly cron |
| `src/ipc.ts` → `processTaskIpc()` | Host-side authorization and task CRUD from container IPC files |
| `src/db.ts` | `createTask`, `getDueTasks`, `updateTask`, `updateTaskAfterRun`, `deleteTask`, `logTaskRun` |
| `src/config.ts` | `SCHEDULER_POLL_INTERVAL` (60s), `TIMEZONE` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `schedule_task` and task management MCP tools |
| `src/container-runner.ts` → `writeTasksSnapshot()` | Writes filtered task list to container IPC dir before spawn |

---

## Task Lifecycle: Creation, Storage, and Container Visibility

_Added by external review agent — summarizes the full path a task takes from creation to container-side read access._

### How Tasks Are Created

Tasks originate from one of two paths:

1. **Agent-initiated (normal flow):** An agent inside a container calls the `schedule_task` MCP tool (registered in `container/agent-runner/src/ipc-mcp-stdio.ts`). This writes a JSON IPC file to `/workspace/ipc/tasks/` inside the container, which maps to `data/ipc/{groupFolder}/tasks/` on the host. The host's `processTaskIpc()` in `src/ipc.ts` picks up the file, validates authorization (see Main vs Non-Main section above), and calls `createTask()` in `src/db.ts` to insert a row into the `scheduled_tasks` table in `store/messages.db`.

2. **Direct DB manipulation (admin/debug only):** You can insert rows directly into `store/messages.db` via `sqlite3`. This bypasses all authorization checks and is only appropriate for debugging or migration scripts.

In both cases, the canonical store is always the SQLite database. There is no file-based task storage.

### How Tasks Are Read by Agents (MCP Tools + Snapshot)

Agents cannot query the SQLite database directly — it lives on the host, outside the container. Instead, task visibility works through two mechanisms:

**1. Pre-spawn snapshot (`current_tasks.json`)**

Before a container is spawned (for either a live message or a scheduled task execution), the host calls `writeTasksSnapshot()` in `src/container-runner.ts`. This:

- Queries `getAllTasks()` from the database
- Filters by group visibility: main sees everything, non-main sees only `tasks.filter(t => t.groupFolder === groupFolder)`
- Writes the filtered list to `data/ipc/{groupFolder}/current_tasks.json` on the host
- This file is mounted into the container at `/workspace/ipc/current_tasks.json`

The snapshot contains a subset of fields per task: `id`, `groupFolder`, `prompt`, `script`, `schedule_type`, `schedule_value`, `status`, `next_run`.

**2. MCP tools that read the snapshot**

The `list_tasks` tool in `container/agent-runner/src/ipc-mcp-stdio.ts` reads `/workspace/ipc/current_tasks.json` and returns its contents. It applies a secondary filter inside the container as well (`isMain ? allTasks : allTasks.filter(t => t.groupFolder === groupFolder)`) — this is belt-and-suspenders since the host already pre-filters, but it means even if the snapshot were somehow unfiltered, the tool would still restrict visibility.

Note: The README's MCP tools table lists `get_task` but **no `get_task` tool is currently implemented** in `ipc-mcp-stdio.ts`. Agents can only list tasks via `list_tasks`; there is no single-task detail/history lookup tool at this time.

This means:
- The data an agent sees is a **point-in-time snapshot** from when its container was spawned
- If another agent creates or modifies a task after this container started, the change won't be visible until the next container spawn
- The snapshot is **read-only** from the container's perspective — agents cannot modify it directly
- Run history (`task_run_logs`) is not exposed to agents at all — it's only accessible via direct DB queries on the host

### Why the Snapshot Exists (Instead of Live DB Access)

The architecture is intentional:

- **Security isolation:** Containers never have direct access to the host's SQLite database. All mutations go through IPC files that the host validates and authorizes.
- **Simplicity:** The agent doesn't need a database client or network access to the host. It reads a flat JSON file.
- **Filtering enforcement:** The host controls what data enters the container. A non-main container physically cannot see other groups' tasks because the data is never written into its mount.

### The Full Round-Trip

```
Agent calls schedule_task MCP tool
  → container/agent-runner validates params (preflight)
  → writes JSON to /workspace/ipc/tasks/{timestamp}-{uuid}.json
  → host's processTaskIpc() reads the file from data/ipc/{group}/tasks/
  → host checks authorization (isMain || own group)
  → host calls createTask() → INSERT into scheduled_tasks table
  → task is now in SQLite, scheduler loop will pick it up when due

Agent calls list_tasks MCP tool
  → reads /workspace/ipc/current_tasks.json (written at container spawn time)
  → returns pre-filtered snapshot (stale if tasks changed since spawn)
```

### Staleness and Refresh

The snapshot is written once per container spawn. For long-running containers (live conversations with 30-min idle timeout), the task list can become stale. There is no live-refresh mechanism — if an agent needs to see freshly-created tasks, the container must be respawned (which happens naturally on the next message or task execution).

For scheduled tasks specifically, this is rarely an issue: task containers are single-turn (10-second close delay after result), so each execution gets a fresh snapshot.
