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

> Set `API_TOKEN` if auth is enabled: `export API_TOKEN=$(grep API_TOKEN .env | cut -d= -f2)`

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups \
  | jq '.data | sort_by(.addedAt) | reverse | .[] | {folder, name}'
```

Display as a numbered list. AskUserQuestion: "Which group would you like to configure?"

### 2. Fetch Current Config

```bash
JID=$(curl -sS -H "Authorization: Bearer $API_TOKEN" http://localhost:3100/api/groups \
  | jq -r ".data[] | select(.folder==\"<folder>\") | .jid")
curl -sS -H "Authorization: Bearer $API_TOKEN" "http://localhost:3100/api/groups/${JID}/config" | jq .
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
- Model Preset (preset selection via model-presets.json)
- Tools & Skills (allowedTools, skills)
- Host Commands (allowedHostCommands)
- Security & Permissions (ssrfProtection, injectionScanMode, approvalMode, approvalTimeout, commandAllowlist, learningLoop)
- Mounts & Filesystem (additionalMounts)
- MCP Servers (mcpServers)
- Personality (systemPrompt, timeout)

For each selected category, ask the questions below. Use current values as defaults.

### 4. Category: Model Preset

**Preset Selection:**

Read available presets from `~/.config/nanoclaw/model-presets.json`:

```bash
cat ~/.config/nanoclaw/model-presets.json | python3 -c "import sys,json; [print(f'  {k}: {v[\"endpoint\"]}/{v[\"model\"]}') for k,v in json.load(sys.stdin).items()]"
```

AskUserQuestion: "Which preset should this group use?"
- List all available preset names with their endpoint/model
- (current preset shown as default)

Store as `preset`.

> **Note:** Presets define endpoint, model, capabilities (vision, tools), contextWindow, and webSearchVendor. These fields are no longer stored directly in containerConfig — they are resolved at runtime from the preset name via `resolvePreset()`.

**Switching presets at runtime:** Users can also switch presets via the `/model <preset>` host command (requires `allowedHostCommands: ['model']`). The container is recycled on switch.

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

Host commands are intercepted on the host process before reaching the agent container. They split into **ungated** (always available) and **gated** (require `allowedHostCommands` entry).

All host commands require the sender to be on the sender allowlist (`~/.config/nanoclaw/sender-allowlist.json`).

#### Ungated Commands (always available)

| Command | Behaviour | Reply Pattern |
|---------|-----------|---------------|
| `/stop` | Aborts the in-flight model request via AbortController. Session preserved — next message resumes the same conversation. | Single deferred reply after container exits: `"⏹ Stopped. Next message continues the conversation."` |
| `/shutdown` | Stops the container. Session preserved — next message starts a new container with the same session. | Single deferred reply after container exits: `"Container stopped. Next message will start a new container with the same session."` |

#### Gated Commands (require `allowedHostCommands` config)

| Command | Behaviour | Reply Pattern |
|---------|-----------|---------------|
| `/model [<preset>]` | No args: shows active preset + available list. With arg: switches to the named preset, recycles container, sanitizes session JSONL for cross-provider safety. | Two-message UX: Reply 1 `"Switching to <preset>..."` (immediate), Reply 2 `"Switched to <preset> (endpoint / model)."` (after container exits) |
| `/version [info\|stable\|next]` | No args: shows current channel, image tag, SDK/CLI versions, drift detection. With arg: switches the group's container channel, recycles container. | Two-message UX: Reply 1 `"Switching to channel <ch>..."` (immediate), Reply 2 `"✅ Switched to channel: <ch>."` (after container exits) |
| `/newsession` | Stops container, deletes session from memory + the database. JSONL transcript left on disk. Next message starts a completely fresh session. | Two-message UX: Reply 1 `"Clearing session..."` (immediate), Reply 2 `"Session cleared. Next message starts fresh."` (after container exits) |

#### How the Two-Message UX Works

Gated commands that do post-shutdown work use an `onAfterExit` queue pattern:
1. **Reply 1** arrives immediately — confirms the command was received
2. The container is told to shut down (`closeStdin` writes `_close` sentinel)
3. After the container actually exits, the post-exit callback runs (DB update, session clear, etc.)
4. **Reply 2** arrives — confirms the work is done

For `/stop` and `/shutdown` (ungated), there is no Reply 1 — only a single deferred message after the container exits. This is because they don't do additional work; the reply just confirms truthful timing.

#### Enabling Gated Commands

AskUserQuestion (multiSelect): "Which host commands should be enabled for this group?"

Options:
- model (enables `/model` to switch model presets)
- version (enables `/version` to show/switch container channel)
- None (secure default)

Store as `allowedHostCommands`. If "None" selected, set to `[]` or undefined.

Example:
```json
{
  "allowedHostCommands": ["model", "version"]
}
```

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

AskUserQuestion: "Disable command approval for this group?"
- No (default — keep approval gate active for write-mounted paths)
- Yes — disable approval, allow raw Bash without confirmation

> ⚠️ Disabling means dangerous commands targeting write-mounted paths run without confirmation. Recommended only for trusted/internal groups.

If "No" (keep approval): do not set `approvalMode` (defaults to `true`). Optionally configure:
- AskUserQuestion: "Approval timeout (seconds)?" → default 120, range 10–600 → store as `approvalTimeout`
- AskUserQuestion (multiSelect): "Any commands that should skip approval? (regex patterns)"
  - `^git\\b`
  - `^npm run test$`
  - Custom pattern (free text)
  - None
  Store as `commandAllowlist`.

If "Yes" (disable): store `approvalMode: false`.

Store as `approvalMode`: true (or absent) / false.

**Learning Loop:**

AskUserQuestion: "Enable skill extraction during memory flush?"
- No (default)
- Yes — extract and load skills automatically
- Extract-only — extract but don't load (review first)

Store as `learningLoop`: true / false / "extract-only".

### 8. Category: Mounts & Filesystem

**Additional Mounts:**

> **Note:** Write mounts (`readonly: false`) are gated by `approvalMode` (on by default — see Security & Permissions category).

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
- The web search vendor is determined by the group's resolved preset (`webSearchVendor` field). Ensure the preset has the correct vendor configured.
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
  ~ preset: "ollama_k2.6"
  + allowedHostCommands: ["model", "version"]
  ~ allowedTools: ["Read", "Write", "Grep", "Bash"]
```

Use `+` for additions, `~` for changes, `-` for removals.

AskUserQuestion: "Apply these changes?"

If yes, apply the changes via the API. PATCH `/api/groups/{jid}/config` is a **merge-patch** — only the keys you send are updated, the rest are preserved:

```bash
JID="tg:..."  # resolved from folder via /api/groups

# Example: set preset and allowedHostCommands
curl -sS -X PATCH -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"preset":"ollama_k2.6","allowedHostCommands":["model"]}' \
  "http://localhost:3100/api/groups/${JID}/config"
```

**Important:** Multiple fields can be sent in a single PATCH body; the API merges them into the existing `containerConfig`. See `docs/api.md` for the merge vs replace semantics.

Verify:

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" "http://localhost:3100/api/groups/${JID}/config" | jq .
```

Show the updated config and confirm success.

### 12. Post-Configuration

If `preset` was changed:

> **Note:** The next message to this group will spawn a fresh container with the new preset. You do not need to restart NanoClaw for containerConfig changes to take effect.

If the group is currently active (has a running container), you may want to recycle it:

```bash
# Find and stop the active container for this group
docker ps --filter "name=nanoclaw-<folder>" --format "{{.Names}}" | xargs -r docker stop
```

---

## Full containerConfig Reference

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `preset` | `string` | `undefined` | Named model preset from `~/.config/nanoclaw/model-presets.json` — resolves endpoint, model, capabilities, contextWindow, webSearchVendor |
| `skills` | `string[]` | `undefined` = all | Per-group skill selection. `[]` = none |
| `allowedTools` | `string[]` | `undefined` = default | Per-group tool restrictions |
| `mcpServers` | `object` | `undefined` = nanoclaw only | Per-group MCP servers |
| `systemPrompt` | `string` | `undefined` | Appended after `claude_code` preset prompt |
| `timeout` | `number` | `300000` (5 min) | Container timeout in ms |
| `additionalMounts` | `AdditionalMount[]` | `[]` | Extra host directories |
| `telegramBot` | `string` | `undefined` | Named Telegram bot instance |
| `allowedHostCommands` | `string[]` | `undefined` = none | Gated host command allowlist (`'model'`, `'version'`) |
| `ssrfProtection` | `boolean \| SsrfConfig` | `true` | SSRF protection |
| `injectionScanMode` | `'off' \| 'warn' \| 'block'` | `'warn'` | Prompt injection scanning |
| `approvalMode` | `boolean` | `true` | Command approval gate |
| `approvalTimeout` | `number` | `120` | Approval timeout in seconds |
| `commandAllowlist` | `string[]` | `[]` | Pre-approved command patterns |
| `learningLoop` | `boolean \| 'extract-only'` | `false` | Skill extraction during flush |
