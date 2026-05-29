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
| Web | `WebFetch` | Fetch URL content | **No — external network** |
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
| Agent teams | `Agent` | Invoke sub-agent | Yes (within container) |
| Skills | `Skill` | Invoke SDK skill | Yes |
| Skills | `RemoteTrigger` | Trigger remote skill | Yes |
| User | `AskUserQuestion` | Prompt user for input | Yes (SDK internal) |
| Misc | `TodoWrite` | Write todo items | Yes |
| Misc | `ToolSearch` | Search available tools | Yes |

## WebSearch & WebFetch — Anthropic Only

`WebSearch` and `WebFetch` are **exclusive to Anthropic-native models**. They do not work with Ollama-proxied models (kimi, glm, etc.) because they rely on Anthropic's server-side web search infrastructure.

**For non-Anthropic models**: Use the `nanoclaw-web-search` MCP server instead. This routes through the credential proxy and supports multiple search vendors (configured via preset's `webSearchVendor` field).

**Recommendation**: Always exclude `WebSearch` and `WebFetch` from `allowedTools` and use `nanoclaw-web-search` MCP for web access. This gives a single, consistent web search path regardless of model provider.

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
