# Agent Team Patterns

How to coordinate multiple agents in NanoClaw — both within a single container and across groups.

---

## Terminology

| Term | Meaning |
|------|---------|
| **Group** | A registered chat configuration (one row in `registered_groups` table). NOT a collection of agents. |
| **Container** | Isolated Docker environment where an agent runs. One container per group. |
| **Agent** | An AI assistant with its own memory, session, and personality. Implemented as a group/container pair. |
| **Trigger** | A pattern like `@andy` that activates a specific group in a chat. |

---

## Three Levels of Coordination

| Level | Scope | Mechanism | Status |
|-------|-------|-----------|--------|
| **Container** | Within one container | Agent tool spawning subagents | Partial (solo works, team broken) |
| **Chat** | Multiple agents in one chat | Trigger patterns | ✅ Works |
| **Cross-Group** | Multiple containers talking to each other | IPC + shared queue | ❌ Not implemented |

---

## Level 1: Container-Level Agents (SDK Agent Tool)

The Agent SDK supports two patterns for spawning subagents **within a single container**:

| Pattern | Behavior | Use Case |
|---------|----------|----------|
| **Solo Agent** | Executes initial prompt immediately | Independent tasks, parallel work |
| **Team Agent** | Waits for mailbox messages | Dynamic coordination, inter-agent communication |

---

## Pattern 1: Solo Agents

Each agent is spawned independently and executes its initial prompt immediately.

### How It Works

```
Lead Agent
├── Spawn Agent A with task in prompt → Agent A executes → Returns result
├── Spawn Agent B with task in prompt → Agent B executes → Returns result
└── Spawn Agent C with task in prompt → Agent C executes → Returns result
```

- Agents run in parallel (if spawned concurrently)
- Each agent has its own context
- Results return to lead agent
- No inter-agent communication

### When to Use

- Independent tasks that don't require coordination
- Parallel execution is beneficial
- Each agent's task is known upfront
- No need for agents to communicate with each other

### Example Prompt for Lead Agent

```
I need you to spawn 3 independent agents to work in parallel:

1. Use the Agent tool to spawn a "Researcher" agent with this prompt:
   "List all files in /workspace/group/logs/ and count them. Use send_message with sender='Researcher' to report the count."

2. Use the Agent tool to spawn a "Writer" agent with this prompt:
   "Create /workspace/group/output.txt with the content 'Task complete'. Use send_message with sender='Writer' to confirm."

3. Use the Agent tool to spawn a "Verifier" agent with this prompt:
   "Read /workspace/group/output.txt and verify it exists. Use send_message with sender='Verifier' to report PASS or FAIL."

Spawn all three agents now. Do NOT use team_name - spawn them as individual agents.
```

### Key Points

- **Do NOT use `team_name` parameter**
- Include the complete task in each agent's prompt
- Each agent should use `send_message` with their role name to report progress
- Agents execute independently and return results to the lead

---

## Pattern 2: Team Agents

> **⚠️ BROKEN (2026-03-29): Does not work in SDK programmatic mode.**
>
> **Root cause:** In SDK mode, the agent's execution loop exits after returning a `ResultMessage`. When a teammate receives a `SendMessage`, it marks the message `read: true` and sends an `idle_notification` heartbeat, but never re-enters the tool-calling loop to act on it. The agent is alive but "zombie" — it cannot execute.
>
> **Why it works in interactive mode:** `<teammate-message>` blocks are delivered between turns in interactive CLI. SDK mode has no "next turn" mechanism.
>
> **Additional bug (v2.1.76):** `TeamCreate` generates spawn commands that invoke the node binary path directly with `env` rather than `claude` from PATH, causing teammate processes to silently exit on spawn.
>
> **Do not use `SendMessage` to deliver tasks in SDK mode.** It will not trigger execution.
>
> **Use Pattern 1 (Solo Agents) with file-based coordination instead.**

Agents are spawned as a team and wait for mailbox messages from the lead agent.

### How It Works

```
Lead Agent
├── Spawn Team (agents with team_name) → Agents enter waiting state
│   ├── Agent A: waiting for mailbox
│   ├── Agent B: waiting for mailbox
│   └── Agent C: waiting for mailbox
├── Send task to Agent A via SendMessage → Agent A executes → Returns result
├── Send task to Agent B via SendMessage → Agent B executes → Returns result
├── Send task to Agent C via SendMessage → Agent C executes → Returns result
└── Coordinate results
```

- Agents wait for explicit tasking via `SendMessage`
- Lead agent can assign tasks dynamically
- Agents can send results back to lead
- More coordination overhead, but more flexible

### When to Use

> **⚠️ DOES NOT WORK IN SDK MODE.** Use Pattern 1 with file-based coordination instead.

- Dynamic task assignment (decide tasks at runtime)
- Inter-agent communication needed
- Lead agent needs to coordinate based on intermediate results
- Task distribution depends on conditions

### Example Prompt for Lead Agent

```
Create a team of agents to analyze a codebase. Use the team workflow:

STEP 1 - SPAWN TEAM:
Use the Agent tool to spawn 3 agents WITH team_name="CodeReviewTeam":
- Agent "Finder": Prompt = "You are a code finder. Wait for tasks via SendMessage."
- Agent "Analyzer": Prompt = "You are a code analyzer. Wait for tasks via SendMessage."
- Agent "Reporter": Prompt = "You are a reporter. Wait for tasks via SendMessage."

Do NOT give them initial tasks - they will wait for your instructions.

STEP 2 - ASSIGN TASKS:
After spawning, use SendMessage to send tasks:

- To Finder: "Find all TypeScript files in /workspace/project/src/ that contain 'export function'"
- To Analyzer: "Analyze the files found by Finder for complexity"
- To Reporter: "Summarize findings from Analyzer in a report"

STEP 3 - COLLECT RESULTS:
Use SendMessage to ask each agent for their results. They will respond with their findings.

STEP 4 - SYNTHESIZE:
After receiving all results, provide a final summary to the user.
```

### Key Points

- **MUST use `team_name` parameter** - this tells agents to wait for mailbox
- Agents enter waiting state after spawn
- Lead agent uses `SendMessage` to assign tasks
- More coordination required but more flexible

---

## Sender Attribution

Both patterns support the `send_message` MCP tool with `sender` parameter:

```typescript
mcp__nanoclaw__send_message({
  text: "Found 3 results",
  sender: "Researcher"  // Appears as sender_name in database
})
```

This allows tracking which agent sent which message in the conversation.

---

## Testing Prompts

### Solo Agent Test

Send this to a group:

```
Spawn 2 solo agents to work in parallel. Do NOT use team_name.

1. Spawn an agent with prompt: "List files in /workspace/group/logs/ and report the count using send_message with sender='Agent1'"

2. Spawn another agent with prompt: "Create /workspace/group/test.txt with content 'test' and confirm using send_message with sender='Agent2'"

After both complete, summarize their results.
```

**Expected behavior:**
- Both agents spawn and execute immediately
- Each sends a message with their sender name
- Lead agent summarizes results
- Check database for `sender_name` values: "Agent1" and "Agent2"

### Team Agent Test

> **⚠️ This test will NOT work in SDK mode.** Team agents receive messages but never execute. This section exists for documentation purposes only — use the Solo Agent Test instead.

Send this to a group:

```
Create a team using the Agent tool with team_name="TestTeam".

STEP 1: Spawn 2 agents with team_name="TestTeam":
- "MemberA" with prompt: "You are MemberA. Wait for tasks via SendMessage."
- "MemberB" with prompt: "You are MemberB. Wait for tasks via SendMessage."

STEP 2: After spawning, use SendMessage to send each a task:
- To MemberA: "Count files in /workspace/group/logs/ and reply with the count"
- To MemberB: "Create /workspace/group/team-test.txt with content 'team test' and confirm"

STEP 3: Wait for both to respond, then summarize results.
```

**Expected behavior:**
- Agents spawn and enter waiting state
- Lead agent sends tasks via SendMessage
- Each agent executes their assigned task
- Lead agent coordinates and summarizes

---

## Workaround: File-Based Coordination

When agents need to coordinate (wait for each other's results), use **file polling** instead of `SendMessage`:

```
Spawn Agent A with prompt: "Do task A. Write results to /tmp/agent-a-result.json.
                            When done, create /tmp/agent-a.done"

Spawn Agent B with prompt: "Poll for /tmp/agent-a.done in a loop (check every 5s).
                            When it exists, read /tmp/agent-a-result.json and do task B.
                            Write results to /tmp/agent-b-result.json and create /tmp/agent-b.done"
```

This gives you dependency coordination without relying on the broken mailbox trigger. The key insight: **spawn agents with complete task context + use files for dependency signaling + use `SendMessage` only for completion notifications back to lead**.

---

## Troubleshooting

### Agents go idle without executing tasks

**Cause (in SDK mode):** This is an Anthropic SDK bug, not a usage error. The execution loop exits after `ResultMessage` and never re-enters when `SendMessage` arrives.

**Fix:** Do NOT use `team_name`. Use solo agents with complete tasks in the spawn prompt. If coordination is needed, use file-based coordination (see above).

### Agents execute immediately but should wait

**Cause:** Spawned without `team_name` when coordination was needed

**Fix:** Use file-based coordination in spawn prompts (poll for `/tmp/other-agent.done`), not `SendMessage`. Team agents are broken in SDK mode.

### Lead agent does all the work itself

**Cause (in SDK mode):** Team agents are zombie and cannot respond. Lead agent has no choice but to do the work.

**Fix:** Use solo agents with file-based coordination instead of team agents.

---

## Quick Reference

| Spawn Method | Agent Behavior | Task Assignment | Status |
|--------------|----------------|----------------|--------|
| No `team_name` | Execute prompt immediately | In initial prompt | ✅ Works |
| With `team_name` | Wait for mailbox | Via `SendMessage` | ❌ Broken in SDK mode |

---

## Level 2: Chat-Level Agents (Trigger-Based Multi-Agent)

Multiple agents can operate in the **same chat** by registering multiple groups with different triggers but the same `jid`.

### How It Works

```
Database entries (same chat, different triggers):

  jid: tg:6013943815, folder: andy,      trigger: @andy
  jid: tg:6013943815, folder: research,  trigger: @research
  jid: tg:6013943815, folder: write,     trigger: @write
```

Each agent has its own memory, session, and personality — but they share the same chat history.

### Example Usage

In a single Telegram/WhatsApp chat:

```
User: "@andy what's your opinion?"
Andy: "Here's my take..."

User: "@research find papers on X"
Researcher: "Found 5 relevant papers..."

User: "@write draft a summary"
Writer: "Here's the draft..."
```

### Agent Isolation

Each agent is a separate NanoClaw "group" with independent resources:

| | Andy | Researcher | Writer |
|---|------|------------|--------|
| **Memory** | `groups/andy/CLAUDE.md` | `groups/research/CLAUDE.md` | `groups/write/CLAUDE.md` |
| **Session** | Own `.jsonl` transcript | Own transcript | Own transcript |
| **Container** | Separate instance | Separate instance | Separate instance |
| **Skills** | Configurable per agent | Configurable per agent | Configurable per agent |

### Shared Context

Agents can read each other's messages because they're in the same chat:

```
Andy: "I think Researcher should look at this."
User: "@research analyze Andy's suggestion"
Researcher: "Based on Andy's point, here's my analysis..."
```

The chat history is the shared context. Each agent sees the full conversation.

### Setup

1. Create multiple group folders:
   ```bash
   mkdir -p ~/.nanoclaw/groups/andy
   mkdir -p ~/.nanoclaw/groups/research
   mkdir -p ~/.nanoclaw/groups/write
   ```

2. Create `CLAUDE.md` for each with distinct personalities/instructions.

3. Register each in the database:
   ```sql
   INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
   VALUES
     ('tg:6013943815', 'Andy', 'andy', '@andy', datetime('now'), 0),
     ('tg:6013943815', 'Researcher', 'research', '@research', datetime('now'), 0),
     ('tg:6013943815', 'Writer', 'write', '@write', datetime('now'), 0);
   ```

### Limitations

- **No autonomous cross-talk**: Agents can only respond when triggered by a human. Andy cannot directly ask Researcher to do something.
- **No programmatic coordination**: You can't script "Andy delegates to Researcher" without a human in the loop.
- **Manual trigger required**: Each agent activation needs its trigger pattern in a message.

### When to Use

- Multiple personas or specialist agents in one chat
- Human-in-the-loop workflows where you decide which agent to invoke
- Each agent needs independent memory/personality
- Simpler than building cross-container messaging

---

## Level 3: Cross-Group Agents (Container-to-Container)

> **⚠️ NOT IMPLEMENTED** — This is a proposed architecture, not current functionality.

Containers communicating with each other via a shared message queue. This would enable:

- Autonomous delegation (one agent asking another to do work)
- Programmatic coordination (scripts triggering multi-agent workflows)
- Response routing (responses flow back to the orchestrator)

### Proposed Architecture

```
                        ┌─────────────────────────┐
                        │   team_messages table    │
                        │   (shared queue)         │
                        └─────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
         Group A              Group B              Group C
       (Orchestrator)        (Researcher)         (Writer)
              │                    │                    │
              ▼                    ▼                    ▼
        sends tasks          receives task        receives task
        via IPC              via queue poll       via queue poll
```

### Why Build This

The broken SDK team-agent pattern (Level 1 with `team_name`) would work at this level because:

| SDK Team Agents | NanoClaw Team Containers |
|-----------------|--------------------------|
| Same process (memory bugs) | Isolated containers |
| Execution loop exits | Independent IPC polling |
| No persistence | SQLite persists messages |
| Can't resume | Containers can restart |

**Container isolation fixes the SDK bug.**

### Implementation Requirements

1. New `team_messages` table for inter-group messaging
2. New `send_team_message` MCP tool in containers
3. Team registration (groups belong to a "team" with roles)
4. IPC handler to poll and route messages

### Related Concepts

- **`is_main` flag**: Grants elevated IPC permissions (can send to any group). See `docs/IPC.md` for details.
- **IPC**: File-based mechanism for external tools to send messages/tasks. See `docs/IPC.md`.

### Current IPC Authorization

| `is_main` | Can Send To | Can Modify Tasks In |
|-----------|-------------|---------------------|
| `true` | Any registered group | Any group |
| `false` | Only its own chat | Only its own group |

Main groups can push messages OUT to any group, but responses don't automatically route back. This is the gap that Level 3 would fill.

---

## Comparison Summary

| Pattern | Scope | Coordination | Autonomous? | Status |
|---------|-------|--------------|-------------|--------|
| Solo Agent (no `team_name`) | Within container | One-shot task | No — executes and returns | ✅ Works |
| Team Agent (with `team_name`) | Within container | Mailbox-based | No — broken in SDK | ❌ Broken |
| Trigger Multi-Agent | Same chat | Human triggers each | No — needs human | ✅ Works |
| Cross-Group Team | Across containers | Shared queue | Yes — agents can message each other | ❌ Not built |