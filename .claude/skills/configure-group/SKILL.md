---
name: configure-group
description: Configure per-group container settings (containerConfig). Use when user wants to change a group's model, endpoint, allowed tools, skills, security settings, mounts, host commands, MCP servers, or any other containerConfig field. Triggers on "configure group", "group config", "container config", or direct invocation.
---

# Configure Group

Interactive per-group `containerConfig` setup. Run `/configure-group` or `/configure-group <folder>`.

## Flow

### 1. Identify Group

If the user provided a folder name (e.g. `/configure-group telegram_main`), use it directly.

If no folder provided, query registered groups:

```bash
sqlite3 store/messages.db "SELECT folder, name, container_config FROM registered_groups ORDER BY added_at DESC"
```

Display as a numbered list. AskUserQuestion: "Which group would you like to configure?"

### 2. Fetch Current Config

```bash
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<folder>'"
```

Parse the JSON. If `container_config` is NULL or empty, treat as `{}`.

Show the current config in a code block:

```
Current containerConfig for '<folder>':

{ ...pretty-printed JSON... }
```

### 3. Select Categories to Configure

AskUserQuestion (multiSelect): "What would you like to configure?"

Options:
- Model & Endpoint (model, endpoint, contextWindowSize)
- Tools & Skills (allowedTools, skills)
- Host Commands (allowedHostCommands)
- Security & Permissions (ssrfProtection, injectionScanMode, approvalMode, approvalTimeout, commandAllowlist, learningLoop)
- Mounts & Filesystem (additionalMounts)
- MCP Servers (mcpServers, webSearchVendor)
- Personality (systemPrompt, timeout)

For each selected category, ask the questions below. Use current values as defaults.

### 4. Category: Model & Endpoint

**Endpoint:**

Read available vendors from `~/.config/nanoclaw/secrets.env`:

```bash
grep "_BASE_URL=" ~/.config/nanoclaw/secrets.env | sed 's/_BASE_URL=.*//' | tr '[:upper:]' '[:lower:]'
```

AskUserQuestion: "Which endpoint should this group use?"
- anthropic (default)
- ollama
- zai
- ... (any vendors found in secrets.env)

Store as `endpoint`.

**Model:**

AskUserQuestion: "Set a specific model for this group?"
- Use preset / inherit from settings.json (recommended)
- Set custom model (e.g. claude-opus-4-7, glm-5:cloud, sonnet, haiku)

If custom: AskUserQuestion (free text): "Enter model name:" → store as `model`.
If inherit: AskUserQuestion: "Remove database override so group uses settings.json?" → if yes, record `model` for removal.

**Context Window Size:**

AskUserQuestion: "Context window size (tokens)?"
- 128000 (default)
- 64000
- 200000
- Custom (free text)

Store as `contextWindowSize`.

### 5. Category: Tools & Skills

**Allowed Tools:**

Show current `allowedTools` (or "All tools" if undefined).

AskUserQuestion (multiSelect): "Which tools should this group have access to?"

Options (full list):
- Read
- Write
- Edit
- Glob
- Grep
- Bash
- NotebookEdit
- WebSearch
- WebFetch
- EnterPlanMode
- ExitPlanMode
- TaskCreate
- TaskGet
- TaskList
- TaskUpdate
- TaskStop
- TaskOutput
- CronCreate
- CronDelete
- CronList
- EnterWorktree
- ExitWorktree
- TeamCreate
- TeamDelete
- SendMessage
- Agent
- Skill
- RemoteTrigger
- AskUserQuestion
- TodoWrite
- ToolSearch

> Note: `mcp__nanoclaw__*` is always included regardless of selection.

If they select all or most, set `allowedTools` to undefined (all tools).
If they select a subset, set exactly those.
If they select none, set `[]`.

**Skills:**

List available skills from `container/skills/`:

```bash
ls container/skills/
```

AskUserQuestion (multiSelect): "Which filesystem skills should be copied into this group's container?"

Options: all directories found in `container/skills/`, plus:
- All skills (default / backward compatible)
- No skills

If "All skills" selected: set `skills` to undefined (remove key).
If "No skills" selected: set `skills` to `[]`.
If specific skills selected: set `skills` to the selected array.

### 6. Category: Host Commands

**Allowed Host Commands:**

AskUserQuestion (multiSelect): "Which host commands should be enabled for this group?"

Options:
- model (enables `/model` to switch model presets)
- None (secure default)

Store as `allowedHostCommands`. If "None" selected, set to `[]` or undefined.

### 7. Category: Security & Permissions

**SSRF Protection:**

AskUserQuestion: "Enable SSRF protection on outbound web requests?"
- Enabled (default)
- Disabled (allows internal network access)
- Enabled but allow private networks (RFC 1918, loopback)

Store as:
- Enabled → `true` or undefined
- Disabled → `false`
- Allow private → `{ "allowPrivateNetworks": true }`

**Prompt Injection Scanning:**

AskUserQuestion: "Scan context files (CLAUDE.md, memory) for prompt injection before container launch?"
- Warn and continue (default)
- Block on critical findings
- Off (skip scanning)

Store as `injectionScanMode`: warn / block / off.

**Command Approval:**

AskUserQuestion: "Enable command approval for dangerous operations on write-mounted paths?"
- No (default — Bash available as normal)
- Yes — require approval for dangerous commands

If yes:
- AskUserQuestion: "Approval timeout (seconds)?" → default 120, range 10–600 → store as `approvalTimeout`
- AskUserQuestion (multiSelect): "Any commands that should skip approval? (regex patterns)"
  - `^git\\b`
  - `^npm run test$`
  - Custom pattern (free text)
  - None
  Store as `commandAllowlist`.

Store as `approvalMode`: true / false.

**Learning Loop:**

AskUserQuestion: "Enable skill extraction during memory flush?"
- No (default)
- Yes — extract and load skills automatically
- Extract-only — extract but don't load (review first)

Store as `learningLoop`: true / false / "extract-only".

### 8. Category: Mounts & Filesystem

**Additional Mounts:**

AskUserQuestion: "Add extra host directories to this group's container?"
- No (default)
- Yes

If yes, repeat until user says done:
- AskUserQuestion (free text): "Host path (absolute):"
- AskUserQuestion (free text): "Container path (e.g. finance, docs):"
- AskUserQuestion: "Read-only?"
  - Yes (recommended for safety)
  - No

Build `additionalMounts` array. Validate host path exists with `test -d <path>`.

### 9. Category: MCP Servers

**Web Search:**

AskUserQuestion: "Enable web search for this group?"
- No (built-in WebSearch/WebFetch only works with Anthropic endpoint)
- Yes — use nanoclaw-web-search MCP server

If yes:
- Read web search vendors from `secrets.env` (`*_WEB_SEARCH_BASE_URL`)
- AskUserQuestion: "Which web search vendor?" → store as `webSearchVendor`
- Add `nanoclaw-web-search` to `mcpServers`

**Brave Search:**

AskUserQuestion: "Enable Brave Search MCP server?"
- No
- Yes

If yes, add to `mcpServers`.

**Transcription:**

AskUserQuestion: "Enable local audio transcription (whisper.cpp)?"
- No
- Yes

If yes, add `nanoclaw-transcription` to `mcpServers`.

### 10. Category: Personality

**System Prompt:**

AskUserQuestion (free text): "Append a custom system prompt for this group? (Leave blank for preset only)"

If provided, store as `systemPrompt`.

**Timeout:**

AskUserQuestion: "Container timeout (minutes)?" → default 5, convert to ms → store as `timeout`.

### 11. Build and Execute SQL

After collecting changes, show a summary:

```
Changes for '<folder>':
  endpoint: "ollama"
  + allowedHostCommands: ["model"]
  ~ allowedTools: ["Read", "Write", "Grep", "Bash"]
  - model (removed)
  ~ contextWindowSize: 128000
```

Use `+` for additions, `~` for changes, `-` for removals.

AskUserQuestion: "Apply these changes?"

If yes, build `json_set` / `json_remove` commands:

```bash
# Example: set endpoint and allowedHostCommands, remove model
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(json_set(json_remove(container_config, '$.model'), '$.endpoint', 'ollama'), '$.allowedHostCommands', json('[\"model\"]')) WHERE folder = 'telegram_main'"
```

**Important:** Chain multiple operations into a single UPDATE statement. SQLite's JSON functions are composable:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(json_set(json_remove(container_config, '$.model'), '$.endpoint', 'ollama'), '$.allowedHostCommands', json('[\"model\"]')) WHERE folder = 'telegram_main'"
```

Verify:

```bash
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<folder>'"
```

Show the updated config and confirm success.

### 12. Post-Configuration

If `endpoint` or `model` was changed:

> **Note:** The next message to this group will spawn a fresh container with the new config. You do not need to restart NanoClaw for containerConfig changes to take effect.

If the group is currently active (has a running container), you may want to recycle it:

```bash
# Find and stop the active container for this group
docker ps --filter "name=nanoclaw-<folder>" --format "{{.Names}}" | xargs -r docker stop
```

If `settings.json` was involved (model override removed), mention:

> The group will now use `data/sessions/<folder>/.claude/settings.json` for its model. If that file doesn't exist, the SDK falls back to `.env` → `ANTHROPIC_MODEL`.

---

## Full containerConfig Reference

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `endpoint` | `string` | `"anthropic"` | Named vendor from `secrets.env` (e.g. `"ollama"`, `"zai"`) |
| `skills` | `string[]` | `undefined` = all | Per-group skill selection. `[]` = none |
| `allowedTools` | `string[]` | `undefined` = default | Per-group tool restrictions |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers |
| `model` | `string` | `undefined` = inherit | Per-group model override |
| `systemPrompt` | `string` | `undefined` | Appended after `claude_code` preset prompt |
| `timeout` | `number` | `300000` (5 min) | Container timeout in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories |
| `contextWindowSize` | `number` | `128000` | Token threshold for auto-flush |
| `webSearchVendor` | `string` | `undefined` | Web search vendor routing |
| `telegramBot` | `string` | `undefined` | Named Telegram bot instance |
| `allowedHostCommands` | `string[]` | `undefined` = none | Host command allowlist |
| `ssrfProtection` | `boolean \| SsrfConfig` | `true` | SSRF protection |
| `injectionScanMode` | `'off' \| 'warn' \| 'block'` | `'warn'` | Prompt injection scanning |
| `approvalMode` | `boolean` | `false` | Command approval gate |
| `approvalTimeout` | `number` | `120` | Approval timeout in seconds |
| `commandAllowlist` | `string[]` | `[]` | Pre-approved command patterns |
| `learningLoop` | `boolean \| 'extract-only'` | `false` | Skill extraction during flush |
