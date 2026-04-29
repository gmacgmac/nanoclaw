---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:
> This command is available in your main chat only. Send `/capabilities` there to see what I can do.

Then stop — do not generate the report.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

List skill directories available to you:

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:
- **Core:** Read, Write, Edit, Glob, Grep
- **Shell:** `execute_command` (MCP) — shell commands with approval checks for write-mounted paths. Core `Bash` is also available but bypasses approval entirely; use `allowedTools` to block it if enforcement is required.
- **Web (MCP):** mcp__nanoclaw-web-search__web_search, mcp__nanoclaw-web-search__web_fetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp__nanoclaw__* (messaging, tasks, group management, command execution)

### 3. MCP server tools

NanoClaw exposes tools via the `mcp__nanoclaw__*` prefix. Use them as needed — full descriptions, parameters, and usage guidance are built into the tool definitions.

- `send_message`, `schedule_task`, `list_tasks`, `pause/resume/cancel/update_task`, `get_registered_groups`, `register_group`, `delegate_to_group`, `respond_to_group`, `manual_flush`, `execute_command`, `ping`

### 4. Container skills (Bash tools)

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message. Example:

```
📋 *NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web (MCP): mcp__nanoclaw-web-search__web_search, mcp__nanoclaw-web-search__web_fetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group, delegate_to_group, respond_to_group, manual_flush

*Container Tools:*
• agent-browser: ✓

*System:*
• Group memory: yes/no
• Extra mounts: N directories
• Main channel: yes
```

Adapt the output based on what you actually find — don't list things that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
