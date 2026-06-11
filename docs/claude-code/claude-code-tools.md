# Claude Code SDK Tools Reference

> **Context**: These are the built-in tools provided by the Claude Agent SDK (Claude Code CLI). They are distinct from NanoClaw's IPC tools (`mcp__nanoclaw__*`) and any extra MCP servers configured per-group.

## Tool List

| Category | Tool | Purpose | Container-local? |
|----------|------|---------|-----------------|
| File ops | `Read` | Read file contents | Yes |
| File ops | `Write` | Write/create files | Yes |
| File ops | `Edit` | Edit existing files | Yes |
| File ops | `Glob` | Find files by pattern | Yes |
| File ops | `Grep` | Search file contents | Yes |
| Execution | `Bash` | Execute shell commands | Yes (but can reach mounts) |
| Execution | `NotebookEdit` | Edit Jupyter notebooks | Yes |
| Web | `WebSearch` | Search the web | **No — external network** |
| Web | `WebFetch` | Fetch URL content | **No — not exposed** |
| Planning | `EnterPlanMode` | Enter planning mode | Yes (SDK internal) |
| Planning | `ExitPlanMode` | Exit planning mode | Yes (SDK internal) |
| Tasks | `TaskCreate` | Create SDK sub-task | Yes (SDK internal) |
| Tasks | `TaskGet` | Get SDK task status | Yes (SDK internal) |
| Tasks | `TaskList` | List SDK tasks | Yes (SDK internal) |
| Tasks | `TaskUpdate` | Update SDK task | Yes (SDK internal) |
| Tasks | `TaskStop` | Stop SDK task | Yes (SDK internal) |
| Tasks | `TaskOutput` | Get SDK task output | Yes (SDK internal) |
| Scheduling | `CronCreate` | Create SDK cron job | Yes (SDK internal) |
| Scheduling | `CronDelete` | Delete SDK cron job | Yes (SDK internal) |
| Scheduling | `CronList` | List SDK cron jobs | Yes (SDK internal) |
| Git | `EnterWorktree` | Enter git worktree | Yes (no git in containers) |
| Git | `ExitWorktree` | Exit git worktree | Yes (no git in containers) |
| Agent teams | `TeamCreate` | Spawn sub-agent team | Yes (within container) |
| Agent teams | `TeamDelete` | Delete agent team | Yes (within container) |
| Agent teams | `SendMessage` | Send message to sub-agent | Yes (within container) |
| Agent teams | `Task` ¹ | Invoke sub-agent (see note) | Yes (within container) |
| Skills | `Skill` | Invoke SDK skill | Yes |
| User | `AskUserQuestion` | Prompt user for input | Yes (SDK internal) |
| Misc | `ToolSearch` | Search available tools | Yes |

> ¹ **`Task` / `Agent` naming split** (SDK ≥ v2.1.63): The subagent tool is registered in the `system:init` tools list (and therefore in `tool-allowlist.json` and `deniedTools`) as **`Task`**. However, the SDK emits **`Agent`** in `tool_use` blocks at invocation time. These are the same tool. The ceiling and `deniedTools` must reference **`Task`** to gate subagent spawning — empirically confirmed 2026-06-02 on SDK 0.3.147 (denying `Task` removed the `Agent` capability entirely).
>
> **`RemoteTrigger`** and **`TodoWrite`** are not in the ceiling (`tool-allowlist.json`) and are permanently blocked for all groups. They appeared in earlier SDK versions and are excluded by design.

## WebSearch & WebFetch — Anthropic Only

`WebSearch` is **Anthropic-only** (uses Anthropic's server-side web search). For non-Anthropic models (Ollama-proxied kimi, glm, etc.) the SDK silently fails. `WebSearch` is in `tool-allowlist.json` and gated by the preset's `nativeWebTools` capability (auto-`true` for Anthropic endpoints, `false` elsewhere).

`WebFetch` is **never exposed** in NanoClaw — by design. Always use the `nanoclaw-web-search` MCP `web_fetch` tool instead. The MCP path:
- Works on all providers (Ollama, Z.ai, Anthropic, Bedrock)
- Routes through the credential proxy (no leaked keys)
- Has SSRF protection

Both ceiling and fallback (`repo/src/config.ts` `VERIFIED_CATALOG`) omit `WebFetch`. To opt a single group in (Anthropic-only, with built-in `WebFetch` instead of MCP), see the reinstatement recipe in `repo/src/config.ts:209` JSDoc.

## Bash vs execute_command

The SDK's `Bash` tool executes shell commands with no path restrictions. Inside the container, this is fine for `/workspace/group/` (the agent's own sandbox). However, if `additionalMounts` are configured, `Bash` can write to mounted host paths without approval.

When `approvalMode` is active (default), NanoClaw strips `Bash` from the allowed tools list and the agent uses `mcp__nanoclaw__execute_command` instead. This MCP tool:
- Runs any shell command (functionally equivalent to Bash)
- Checks if the command targets write-mounted paths (`/workspace/extra/*`)
- Requires user approval for dangerous commands targeting those paths
- Respects a per-group `commandAllowlist` for pre-approved patterns

**Net effect**: The agent retains full shell access within its container, but writes to mounted host directories require explicit user approval.

## `allowedTools` Configuration

Controlled via `containerConfig.allowedTools` in the database.

| Value | Behaviour |
|-------|-----------|
| `undefined` | All tools from the list above are available |
| `[]` (empty) | Only `mcp__nanoclaw__*` (IPC tools) — agent can't even read files |
| `["Read", "Write", ...]` | Only listed tools + `mcp__nanoclaw__*` |

`mcp__nanoclaw__*` (NanoClaw's IPC tools) is always injected regardless of this setting. It cannot be blocked via `allowedTools`.

## Relationship to NanoClaw IPC Tools

SDK tools and NanoClaw IPC tools are independent layers:

- **SDK tools** (`allowedTools`): File ops, Bash, web, planning — operate within the container
- **NanoClaw IPC** (`mcp__nanoclaw__*`): send_message, execute_command, schedule_task, etc. — reach outside the container to the host
- **Extra MCP servers** (`mcpServers`): nanoclaw-web-search, brave-search, nanoclaw-transcription — opt-in external services

The `allowedTools` setting has no effect on MCP tools. MCP tools are always available (IPC) or configured separately (extra servers).
