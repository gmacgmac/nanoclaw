# Memory Flush Architecture

Deep reference for the two flush paths: manual (agent-initiated) and nightly (cron-initiated). Covers the full lifecycle, signal flow, edge cases, and concurrency behaviour.

---

## Overview

Memory flush compacts the agent's conversation context into durable files (MEMORY.md, COMPACT.md, daily notes) and resets the session so the next interaction starts fresh with a smaller context window. There are three triggers:

| Trigger | Where | Condition |
|---------|-------|-----------|
| **Manual** | Agent calls `manual_flush` MCP tool | Agent decides context is too large |
| **Token threshold** | Agent-runner checks after each query | `lastInputTokens > contextWindowSize * 0.8` |
| **Nightly cron** | Host cron (midnight daily) | `lastInputTokens / contextWindowSize > 0.5` |

Manual and token-threshold flushes share the same container-side path. Nightly flush uses a separate host-side path.

---

## Manual Flush (Agent-Initiated)

### Trigger

The agent calls the `manual_flush` MCP tool (defined in `ipc-mcp-stdio.ts`). This writes an empty `_flush` sentinel file to `/workspace/ipc/input/_flush`.

### Detection

The sentinel is detected in one of three places in the agent-runner (`container/agent-runner/src/index.ts`):

1. **During active query** — `pollIpcDuringQuery()` checks `shouldFlush()` every 500ms. If found, sets `flushRequestedDuringQuery = true` and calls `stream.end()` to terminate the current query.
2. **After query completes** — `main()` checks `shouldFlush()` after `runQuery()` returns.
3. **During idle wait** — `waitForIpcMessage()` checks `shouldFlush()` alongside `shouldClose()` in its poll loop. Returns `{ type: 'flush' }`.

### Execution

Once detected, the agent-runner:

1. Sends status message: "Creating long term memories..." (via `sendStatusMessage()` — atomic write to IPC messages dir)
2. Runs `getFlushPrompt()` as a single-turn query with `{ acceptIpc: false }`:
   - `stream.end()` is called immediately after pushing the prompt (single-turn mode)
   - `pollIpcDuringQuery` skips `drainIpcInput()` — user messages stay on disk for the next normal query
   - `_close` sentinel is still honoured during flush (safety exit)
3. Sets `flushedThisSession = true` (prevents double-flush)
4. Sends status message: "Ready for next message"
5. Emits `writeOutput({ status: 'success', result: null, newSessionId, flushCompleted: true })`

### Host-Side Handling

The `wrappedOnOutput` callback in `runAgent()` (`src/index.ts`) processes the streamed output:

1. Detects `output.flushCompleted === true`
2. Calls `queue.closeStdin(chatJid)` — writes `_close` sentinel to IPC input dir
3. Deletes session from in-memory `sessions` map and SQLite via `deleteSession()`
4. Sets `sessionFlushed = true` flag

The post-output block in `runAgent()` checks `!sessionFlushed` before re-setting `newSessionId`, preventing session resurrection.

### Container Exit

1. `_close` sentinel written by `closeStdin()`
2. Agent-runner's `waitForIpcMessage()` detects `_close`, returns `{ type: 'close' }`
3. `main()` breaks out of the query loop
4. Container process exits with code 0
5. Docker `--rm` flag cleans up the container

### Signal Flow

```
Agent calls manual_flush MCP tool
  → _flush sentinel written to /workspace/ipc/input/_flush
  → agent-runner detects sentinel (pollIpcDuringQuery / waitForIpcMessage / post-query check)
  → agent-runner runs getFlushPrompt() with acceptIpc=false
  → agent writes MEMORY.md, COMPACT.md, daily note
  → agent responds <internal>done</internal>
  → SDK result event fires
  → writeOutput({ flushCompleted: true }) emitted to stdout
  → host streaming parser catches OUTPUT_START/END markers
  → wrappedOnOutput fires → closeStdin() + deleteSession()
  → _close sentinel written
  → agent-runner detects _close → breaks loop → container exits
```

---

## Token Threshold Flush (Automatic)

Identical to manual flush except the trigger. After each query in `main()`, the agent-runner checks:

```typescript
if (!flushedThisSession && lastInputTokens > contextWindowSize * 0.8)
```

`lastInputTokens` is a module-level variable updated from the SDK's `usage.input_tokens` on every assistant message. `contextWindowSize` defaults to 128000 (configurable per group via `containerConfig.contextWindowSize`).

If the threshold is crossed, the same flush prompt and signal flow as manual flush executes. The 80% threshold is deliberately higher than the nightly 50% threshold — it's a safety net for sessions that grow rapidly between nightly runs.

---

## Nightly Flush (Cron-Initiated)

### Trigger

`startNightlyCron()` in `task-scheduler.ts` schedules `runNightlyMaintenance()` to run at midnight daily (cron: `0 0 * * *`, timezone from config).

### Threshold Check

`runNightlyMaintenance()` in `nightly-maintenance.ts`:

1. Iterates all registered groups with active sessions (session exists in DB)
2. Reads `token-usage.log` from the group folder — first line contains the latest `input=NNN` value
3. Computes `usage = lastTokens / contextWindowSize`
4. Skips groups below 50% threshold
5. Calls `deps.runFlush(group, chatJid)` for groups above threshold

### Container Lifecycle

The `runFlush` callback in `src/index.ts` routes through the GroupQueue:

1. Calls `queue.enqueueTask(chatJid, taskId, fn)` with a synthetic task ID (`nightly-flush-{folder}-{timestamp}`)
2. The queue's `runTask()` sets `state.active = true`, `state.isTaskContainer = true`
3. Inside the task function, `runContainerAgent()` spawns a fresh container with:
   - `prompt: getNightlyFlushPrompt()` — the flush instructions as the initial prompt
   - `sessionId: sessions[group.folder]` — the existing session so the agent has full conversation context
   - `onOutput` callback that tracks session ID, schedules `closeStdin` after 10s delay, and checks `flushCompleted`

### `flushCompleted` Handling

The nightly flush sends the flush prompt as the container's initial (and only) query. The agent-runner processes it as a normal query — no `_flush` sentinel is involved. When the agent finishes:

1. SDK emits `result` event
2. `writeOutput({ status: 'success', result: textResult, newSessionId })` emitted to stdout
3. Host's streaming `onOutput` callback fires — if `flushCompleted` is present, `flushSucceeded` is set immediately
4. Host schedules `closeStdin` after 10s on any result or success status
5. Container enters `waitForIpcMessage()` loop
6. After 10s, `closeStdin` writes `_close` sentinel
7. Agent-runner detects `_close`, breaks loop, container exits with code 0
8. `runContainerAgent` resolves with the final `ContainerOutput`

The host uses a layered success check: `flushCompleted` (if present) OR `status === 'success'` — either sets `flushSucceeded = true`. The `status === 'success'` fallback is safe because the entire container's purpose was the flush prompt:

- The container only runs the flush prompt (no user messages)
- A successful exit means the SDK completed the agent's turn (all tool calls, thinking, and text generation finished)
- An error exit (non-zero code, timeout) resolves with `status: 'error'`, so `flushSucceeded` stays `false`

### Session Cleanup

After `runFlush` returns `true`, `runNightlyMaintenance` calls `clearSession(groupFolder)`:

1. `deleteSession(groupFolder)` — removes from SQLite
2. `delete sessions[groupFolder]` — removes from in-memory map
3. Next user message spawns a fresh container with no session ID → new session JSONL created
4. CLAUDE.md `@import` loads MEMORY.md and COMPACT.md into the new session's context

### Signal Flow

```
Midnight cron fires
  → runNightlyMaintenance() checks token usage per group
  → group above 50% threshold
  → runFlush() called → queue.enqueueTask()
  → queue.runTask() sets active=true, isTaskContainer=true
  → runContainerAgent() spawns container with flush prompt + existing sessionId
  → agent reads MEMORY.md, writes updates, writes COMPACT.md, writes daily note
  → agent responds <internal>done</internal>
  → SDK result event fires
  → writeOutput({ status: 'success' }) emitted to stdout
  → host streaming callback fires → checks flushCompleted (if present) + schedules closeStdin in 10s
  → 10s later: _close sentinel written
  → agent-runner detects _close → breaks loop → container exits code 0
  → runContainerAgent resolves { status: 'success' }
  → flushSucceeded = true (from flushCompleted or status === 'success')
  → runNightlyMaintenance calls clearSession()
  → session deleted from DB + memory
```

---

## Why the Paths Differ

Manual flush happens inside a running container mid-conversation. The sentinel mechanism exists because the agent needs to signal "I want to flush now" to the agent-runner, which orchestrates the flush in a controlled way (no IPC, single-turn). The host reacts to `flushCompleted` because it needs to distinguish a flush completion from a normal query completion within an ongoing chat session.

Nightly flush spawns a dedicated container whose sole purpose is the flush. There's no ongoing conversation, no sentinel to detect, no need for the agent-runner to orchestrate anything special. The host owns the entire lifecycle and knows the container is a flush container because it spawned it as one. The host still checks `flushCompleted` if present (the agent-runner may emit it), but falls back to `status === 'success'` since the container's sole purpose is the flush.

The key architectural difference: manual/threshold flushes emit `flushCompleted: true` explicitly (the agent-runner knows it ran a flush prompt). Nightly flushes may or may not receive `flushCompleted` depending on whether the agent-runner's threshold check fires during the flush query itself — but the host doesn't depend on it.

---

## Concurrency & Edge Cases

### User chatting when nightly cron fires

1. `queue.enqueueTask()` checks `state.active` — chat container is active
2. Flush task pushed to `state.pendingTasks`
3. If agent is idle (`idleWaiting = true`), `closeStdin` fires immediately to preempt
4. If agent is mid-query, flush waits until the chat container exits naturally
5. `drainGroup()` runs after chat container exits, finds pending flush task, spawns flush container
6. Session ID preserved — flush container gets full conversation context

**Impact:** Flush delays the next response by ~30-40 seconds. No data loss.

### User sends message during nightly flush

1. Flush container is a task container (`isTaskContainer = true`)
2. `queue.sendMessage()` returns `false` (checks `!state.isTaskContainer`)
3. Message stored in DB but not piped to the flush container
4. When flush container exits, `drainGroup()` checks `pendingMessages`
5. If messages pending, spawns a new chat container to process them

**Impact:** Message is queued, not lost. Processed after flush completes.

### Multiple groups above threshold

`runNightlyMaintenance` iterates groups sequentially. Each `runFlush` call enqueues a task. The queue's concurrency limit (`MAX_CONCURRENT_CONTAINERS`) applies — excess groups queue behind active ones.

### Flush container times out

If the flush container exceeds the hard timeout (`IDLE_TIMEOUT + 30s`):
- Exit code 137 (SIGKILL)
- `runContainerAgent` resolves with `status: 'error'` (if no streaming output) or `status: 'success'` (if streaming output was received)
- If `status: 'error'`, `flushSucceeded = false`, session is NOT cleared
- The group retries on the next nightly run

### Double-flush prevention

- **Container-side:** `flushedThisSession` flag prevents the agent-runner from running the flush prompt twice in one session
- **Host-side (manual):** `sessionFlushed` flag in `runAgent()` prevents post-output `newSessionId` from resurrecting a cleared session
- **Host-side (nightly):** Each cron run is independent. If the session was already cleared by a manual flush earlier in the day, `runNightlyMaintenance` skips the group (no session in DB)

### Stale sentinel cleanup

On container startup, `main()` deletes any leftover `_close` and `_flush` sentinels from previous runs:

```typescript
try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }
```

### Token-usage.log accuracy

The nightly threshold check reads the first line of `token-usage.log` (newest entry, prepended by the agent-runner). If a flush already ran (manual or threshold), the token count reflects the flush query's lower token usage, not the original session's. This naturally prevents redundant nightly flushes after a same-day manual flush.

---

## File Reference

| File | Role |
|------|------|
| `container/agent-runner/src/index.ts` | Container-side: query loop, sentinel detection, flush execution, `writeOutput` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `manual_flush` MCP tool definition |
| `src/index.ts` | Host-side: `runAgent` (wrappedOnOutput, session management), `runFlush` callback |
| `src/container-runner.ts` | Container spawning, streaming output parsing, timeout handling |
| `src/group-queue.ts` | Queue lifecycle: `enqueueTask`, `runTask`, `closeStdin`, `drainGroup` |
| `src/nightly-maintenance.ts` | `runNightlyMaintenance`, `getNightlyFlushPrompt`, `parseLastInputTokens` |
| `src/task-scheduler.ts` | `startNightlyCron`, cron scheduling |
| `groups/{folder}/token-usage.log` | Per-group token tracking (read by nightly threshold check) |
| `groups/{folder}/memory/MEMORY.md` | Durable facts (appended by flush prompt) |
| `groups/{folder}/memory/COMPACT.md` | Session summary (overwritten by flush prompt) |
| `groups/{folder}/memory/YYYY-MM-DD.md` | Daily notes (appended by flush prompt) |
