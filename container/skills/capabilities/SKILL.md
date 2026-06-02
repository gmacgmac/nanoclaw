---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

**Main-channel check:** ~~Only the main channel has `/workspace/project` mounted.~~ This guard has been removed — `/capabilities` now runs in any group.

## How to gather the information

### 1. Installed skills

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. Read the `description` field from each skill's SKILL.md frontmatter for a one-line summary.

### 2. Shell access mode

```bash
echo "APPROVAL_MODE=${NANOCLAW_APPROVAL_MODE:-unset}"
```

- If `APPROVAL_MODE=true`: shell access is via `mcp__nanoclaw__execute_command` (dangerous commands require user approval). Direct `Bash` tool is disabled.
- If `APPROVAL_MODE=unset` or `false`: direct `Bash` tool is available.

### 3. MCP servers & tools

MCP tools are self-describing — their names, descriptions, and parameters are already in your context from session init. Do NOT hardcode or list individual tool names or descriptions.

To report MCP servers: look at which `mcp__*` tools are available to you, group them by prefix (e.g. `mcp__nanoclaw__*`, `mcp__nanoclaw-web-search__*`), and list each server prefix. The user can ask about specific tools if they want details.

### 4. Container binaries

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message:

```
📋 *NanoClaw Capabilities*

*Skills:*
• /skill-name — description from frontmatter
(list all found)

*Shell:*
• Mode: approval (execute_command) | direct (Bash)

*MCP Servers:*
• nanoclaw — messaging, tasks, scheduling, groups
• nanoclaw-web-search — web search & fetch
(list only servers actually connected)

*Binaries:*
• agent-browser: ✓/✗

*System:*
• Group memory: yes/no
• Extra mounts: N directories
```

Only report what is actually available — omit sections with nothing to show.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
