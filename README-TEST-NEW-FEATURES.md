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
