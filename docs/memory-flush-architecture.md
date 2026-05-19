---
category: nanoclaw-memory
last_updated: 2026-05-19
status: current
scope: Memory persistence architecture — nudge system, host commands, session lifecycle
keywords: memory, nudge, periodic, threshold, nightly, newsession, shutdown, MEMORY.md
---

# Memory Architecture

Deep reference for the continuous memory nudge system. Covers the three nudge triggers, host commands, session lifecycle, concurrency behaviour, and the learning loop.

---

## Overview

Memory persistence is continuous: the agent writes durable facts to `MEMORY.md` throughout its session via periodic nudge prompts. Sessions are long-running — Claude Code's built-in auto-compact handles context window management. There is no flush-and-reset cycle.

### Design Principles

1. **Continuous persistence** — memories are written incrementally, not batched at session end
2. **Long-running sessions** — containers stay alive across messages; no automated session deletion
3. **Auto-compact handles context** — Claude Code compacts the conversation when needed; NanoClaw doesn't manage context size
4. **Explicit session reset only** — only the `/newsession` host command deletes a session

### Nudge Triggers

| Trigger | Where | Condition | Session Deleted? |
|---------|-------|-----------|-----------------|
| **Periodic** | Agent-runner (container) | Every 10 user messages | No |
| **Threshold** | Agent-runner (container) | `lastInputTokens > contextWindowSize * 0.8` | No |
| **Nightly** | Host cron (midnight daily) | `lastInputTokens / contextWindowSize > 0.5` | No |

All three triggers inject the same nudge prompt (with minor variations). None delete the session or stop the container.

---

## Nudge Prompt — Single Source of Truth

Both container-side and host-side use `buildNudgePrompt()` from `nudge-prompt.ts` as the single source of truth. A copy exists at both locations (container boundary — cannot import from host `src/` at runtime):

- `container/agent-runner/src/lib/nudge-prompt.ts` (container-side)
- `src/lib/nudge-prompt.ts` (host-side, used by nightly maintenance)

### What the Nudge Instructs

The nudge prompt is wrapped in `<internal>` tags (invisible to the user) and instructs the agent to:

1. **Durable facts** → `memory/MEMORY.md`
   - Read current file, append new facts, remove superseded entries
   - One bullet per fact, no prose
   - **5000 character cap** — consolidate or prune if approaching limit
2. **Daily note** → `memory/YYYY-MM-DD.md`
   - Append observations and task progress
   - Create file if it doesn't exist
3. **Skill extraction** (nightly only, when `learningLoop` is enabled) → `extracted-skills/[skill-name].md`
   - Up to 2 skills per nudge
   - Only genuinely reusable patterns

The agent continues normal work after the nudge — no announcement, no session interruption.

### Nudge Prompt Variants

| Reason | Opening Line | Skill Extraction? |
|--------|-------------|-------------------|
| `periodic` | "periodic checkpoint" | No |
| `threshold` | "context window reaching capacity" | No |
| `nightly` | "end-of-day persistence check" | Yes (if `learningLoop` enabled) |

---

## Periodic Nudge (Every 10 Turns)

### Trigger

The agent-runner maintains a module-level `turnsSinceLastNudge` counter. It increments after each user message query completes (scheduled tasks are excluded). When it reaches 10:

```
turnsSinceLastNudge >= 10
```

### Execution

1. Counter resets to 0
2. `buildNudgePrompt({ reason: 'periodic' })` generates the prompt
3. Prompt runs as a single-turn query with `acceptIpc: false` (user messages queue on disk)
4. Session ID and resume cursor are updated from the nudge query result
5. Normal query loop continues

### Characteristics

- No user-visible output
- No session deletion
- No container restart
- Scheduled tasks (`isScheduledTask: true`) do not increment the counter

---

## Threshold Nudge (80% Context)

### Trigger

After each query, the agent-runner checks:

```typescript
if (!thresholdNudgedThisSession && lastInputTokens > contextWindowSize * 0.8)
```

`lastInputTokens` is updated from the SDK's `usage.input_tokens` on every assistant message. `contextWindowSize` defaults to 128000 (configurable per group via `containerConfig.contextWindowSize`).

### Execution

1. `thresholdNudgedThisSession` flag set to `true` (prevents repeat firing)
2. `buildNudgePrompt({ reason: 'threshold' })` generates the prompt
3. Prompt runs as a single-turn query with `acceptIpc: false`
4. Session ID and resume cursor updated
5. Normal query loop continues — Claude Code auto-compact handles the actual context reduction

### Characteristics

- Fires at most once per container session
- Does not interact with the periodic nudge counter
- No session deletion, no container restart
- Safety net for rapidly growing sessions between nightly runs

---

## Nightly Nudge (Cron)

### Trigger

`startNightlyCron()` in `task-scheduler.ts` schedules `runNightlyMaintenance()` at midnight daily (cron: `0 0 * * *`, timezone from config).

### Threshold Check

`runNightlyMaintenance()` in `nightly-maintenance.ts`:

1. Iterates all registered groups with active sessions (session exists in DB)
2. Reads `token-usage.log` from the group folder — first line contains the latest `input=NNN` value
3. Computes `usage = lastTokens / contextWindowSize`
4. Skips groups below 50% threshold (`NUDGE_THRESHOLD = 0.5`)
5. Calls `deps.runNudge(group, chatJid)` for groups above threshold

### Execution

The `runNudge` callback enqueues the nudge prompt via the group queue:

1. `queue.enqueueTask(chatJid, taskId, fn)` with a synthetic task ID
2. Queue respects one-container-at-a-time — nudge waits if a chat container is active
3. Nudge prompt (`getNightlyNudgePrompt(learningLoop)`) is injected into the running container via IPC
4. Container processes the nudge as a normal query
5. Container stays alive after nudge completes

### Characteristics

- No session deletion
- No container restart (container stays alive, normal idle timeout applies)
- Includes skill extraction when `learningLoop` is enabled
- Groups below 50% usage are skipped (minimal context = nothing worth persisting)

### Signal Flow

```
Midnight cron fires
  → runNightlyMaintenance() checks token usage per group
  → group above 50% threshold
  → runNudge() called → queue.enqueueTask()
  → nudge prompt injected into container via queue
  → agent reads MEMORY.md, writes updates, writes daily note
  → (optional) agent extracts skills
  → agent continues silently
  → container stays alive
```

---

## Host Commands

### `/shutdown` — Force Stop Container

**Gating**: Ungated (available to all groups). Sender must pass allowlist check.

**Flow**:
1. `closeStdin(jid)` writes `_close` sentinel to IPC input dir
2. Agent-runner detects `_close`, breaks query loop, container exits
3. Session is NOT deleted — next message spawns a new container with the same session
4. Reply: "Container stopped. Next message will start a new container with the same session."

**Use case**: Emergency kill when the agent is stuck or misbehaving. No data loss — session persists.

### `/newsession` — Write Memories & Start Fresh

**Gating**: Requires `allowedHostCommands: ['newsession']` in group config. Sender must pass allowlist check.

**Flow** (container running):
1. `closeStdin(jid)` stops the running container
2. `enqueueNudge(jid, groupFolder)` spawns a fresh container that runs `buildNudgePrompt({ reason: 'periodic' })` to persist memories
3. After nudge completes, `clearSession(groupFolder)` deletes session from in-memory map + SQLite
4. Reply: "Session cleared. Next message starts fresh."

**Flow** (no container running):
1. Skip nudge (nothing to persist — no active conversation)
2. `clearSession(groupFolder)` clears session directly
3. Reply: "Session cleared (no container was running). Next message starts fresh."

**This is the only path that deletes sessions.** All automated nudges (periodic, threshold, nightly) leave sessions intact.

---

## Four Layers of Memory

| Layer | File | Persistence | Written By |
|-------|------|-------------|-----------|
| **Session context** | Claude Code session JSONL | Survives container restarts, deleted only by `/newsession` | Claude Code SDK |
| **Durable facts** | `memory/MEMORY.md` | Permanent (5000 char cap) | Agent via nudge prompt |
| **Daily notes** | `memory/YYYY-MM-DD.md` | Permanent | Agent via nudge prompt |
| **Extracted skills** | `extracted-skills/*.md` | Permanent | Agent via nightly nudge (when learningLoop enabled) |

### Memory Loading

On container startup, the group's `CLAUDE.md` file uses `@import` to load `memory/MEMORY.md` into the agent's context. Daily notes and skills are loaded via their respective mechanisms (skill manager for skills, `@import` for recent daily notes if configured).

---

## Memory Size Cap

The nudge prompt instructs the agent to keep `MEMORY.md` under **5000 characters**. Enforcement is prompt-based only (no host-side validation). If approaching capacity, the agent should:

- Consolidate related facts into fewer entries
- Remove stale or superseded facts
- Keep one bullet point per fact, no prose

Future enhancement: host-side enforcement if prompt-based approach proves insufficient.

---

## Concurrency & Edge Cases

### User chatting when nightly cron fires

1. `queue.enqueueTask()` checks `state.active` — chat container is active
2. Nudge task pushed to `state.pendingTasks`
3. Nudge waits until the chat container's current query completes or container exits
4. Queue processes the nudge task
5. Session preserved throughout

**Impact**: Nudge may delay slightly. No data loss.

### User sends message during nightly nudge

1. Nudge container is a task container (`isTaskContainer = true`)
2. `queue.sendMessage()` returns `false` (checks `!state.isTaskContainer`)
3. Message stored in DB but not piped to the nudge container
4. When nudge completes, `drainGroup()` checks `pendingMessages`
5. If messages pending, spawns a new chat container to process them

**Impact**: Message is queued, not lost. Processed after nudge completes.

### Multiple groups above threshold

`runNightlyMaintenance` iterates groups sequentially. Each `runNudge` call enqueues a task. The queue's concurrency limit applies — excess groups queue behind active ones.

### Double-nudge prevention

- **Threshold**: `thresholdNudgedThisSession` flag prevents repeat firing within one container session
- **Periodic**: Counter resets to 0 after each nudge — cannot fire twice in a row
- **Nightly**: Each cron run is independent. If a session was cleared by `/newsession` earlier, the group has no session in DB and is skipped

### Token-usage.log accuracy

The nightly threshold check reads the first line of `token-usage.log` (newest entry, prepended by the agent-runner). After a nudge, the token count reflects the nudge query's usage. This naturally prevents redundant nightly nudges after a same-day threshold nudge already persisted memories.

---

## Learning Loop — Skill Extraction

When `containerConfig.learningLoop` is truthy, the **nightly** nudge prompt includes a skill extraction step. Periodic and threshold nudges never extract skills.

### How It Works

1. `buildNudgePrompt({ reason: 'nightly', learningLoop })` includes the skill extraction step
2. The agent reviews the session for reusable patterns: workflows, command sequences, decision frameworks, tool usage patterns
3. Agent writes up to 2 skill files to `extracted-skills/[skill-name].md` in the group folder
4. Each skill file has YAML frontmatter and structured sections

### Skill File Format

```markdown
---
name: [skill-name]
extracted: YYYY-MM-DD
source_group: [group-folder]
confidence: high|medium|low
---

# [Skill Name]

## When to Use
[Conditions under which this skill applies]

## Pattern
[The reusable pattern — steps, commands, decision logic]

## Example
[Concrete example from the session]

## Notes
[Caveats, limitations, edge cases]
```

### Skill Loading at Next Session

- `registerGroup()` creates `extracted-skills/` in the group folder
- `buildVolumeMounts()` reads skills via `getExtractedSkills()` and copies valid files into the session's `.claude/skills/` directory
- Loading only activates when `learningLoop === true` (strict equality)
- `'extract-only'` extracts skills during nightly nudge but does not load them into future sessions

### `learningLoop` Values

| Value | Extract during nightly nudge? | Load into next session? |
|-------|-------------------------------|------------------------|
| `undefined` / `false` | No | No |
| `true` | Yes | Yes |
| `'extract-only'` | Yes | No |

---

## File Reference

| File | Role |
|------|------|
| `container/agent-runner/src/lib/nudge-prompt.ts` | Container-side nudge prompt builder (`buildNudgePrompt()`) — single source of truth |
| `src/lib/nudge-prompt.ts` | Host-side copy of nudge prompt builder (used by nightly maintenance) |
| `container/agent-runner/src/index.ts` | Container-side: query loop, periodic nudge counter, threshold nudge, `writeOutput` |
| `src/nightly-maintenance.ts` | `runNightlyMaintenance`, threshold check, `getNightlyNudgePrompt` |
| `src/host-commands.ts` | `/shutdown` and `/newsession` host commands |
| `src/task-scheduler.ts` | `startNightlyCron`, cron scheduling |
| `src/container-runner.ts` | Container spawning, streaming output parsing, timeout handling |
| `src/group-queue.ts` | Queue lifecycle: `enqueueTask`, `runTask`, `closeStdin`, `drainGroup` |
| `src/lib/skill-manager.ts` | Host-side skill reader (`getExtractedSkills()`) |
| `container/skills/learning-loop/SKILL.md` | Skill extraction format guide and quality criteria |
| `groups/{folder}/token-usage.log` | Per-group token tracking (read by nightly threshold check) |
| `groups/{folder}/memory/MEMORY.md` | Durable facts (written by nudge prompt, 5000 char cap) |
| `groups/{folder}/memory/YYYY-MM-DD.md` | Daily notes (appended by nudge prompt) |
| `groups/{folder}/extracted-skills/*.md` | Extracted skill files (written by nightly nudge when learningLoop enabled) |
