# NanoClaw IPC Protocol

Inter-process communication for triggering actions from external tools (dashboards, scripts, other agents).

## Overview

IPC uses a file-based mechanism. Write JSON files to specific directories, and NanoClaw's IPC watcher processes them.

**Base directory**: `DATA_DIR/ipc/` (typically `~/.nanoclaw/data/ipc/`)

**Structure**:
```
DATA_DIR/ipc/
├── {group_folder}/
│   ├── messages/
│   │   └── {uuid}.json    # Outbound messages
│   └── tasks/
│       └── {uuid}.json    # Task operations
├── main/
│   ├── messages/
│   └── tasks/
└── errors/                 # Failed messages land here
```

## Authorization

Each directory maps to a registered group. Authorization depends on the `is_main` flag:

| Source Group | Can Send To | Can Modify Tasks In |
|--------------|-------------|---------------------|
| `is_main=true` | Any registered group | Any group |
| `is_main=false` | Only its own chat | Only its own group |

**For dashboard access**: Register a group with `folder: "dashboard"` and `is_main: 1` in the `registered_groups` table, then write to `DATA_DIR/ipc/dashboard/tasks/`.

---

## Message Operations

### Send Message

Write to: `DATA_DIR/ipc/{group_folder}/messages/{uuid}.json`

```json
{
  "type": "message",
  "chatJid": "120363xxxxxxxxx@g.us",
  "text": "Hello from the dashboard!",
  "sender_name": "Dashboard",
  "source": "dashboard"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Must be `"message"` |
| `chatJid` | string | yes | Target chat JID (must be registered) |
| `text` | string | yes | Message content to send |
| `sender_name` | string | no | Display name for the sender (default: `source` or group folder) |
| `source` | string | no | Source identifier stored as `sender` (default: group folder name) |

**Authorization**: Main group can send to any registered chat. Non-main groups can only send to their own chat.

**Storage**: Messages sent via IPC are stored in the `messages` table with:
- `sender`: `{source}@ipc` (e.g., `dashboard@ipc`)
- `sender_name`: Value from `sender_name` field or `source`
- `is_from_me`: `1` (sent by the bot)
- `is_bot_message`: `0` (not a bot response)

---

## Task Operations

Write to: `DATA_DIR/ipc/{group_folder}/tasks/{uuid}.json`

### Schedule Task

```json
{
  "type": "schedule_task",
  "targetJid": "120363xxxxxxxxx@g.us",
  "prompt": "Check the build status and report any failures",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "context_mode": "isolated",
  "taskId": "custom-task-id-optional"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"schedule_task"` |
| `targetJid` | string | yes | Target chat JID (determines group folder) |
| `prompt` | string | yes | Prompt for the agent to execute |
| `schedule_type` | string | yes | One of: `cron`, `interval`, `once` |
| `schedule_value` | string | yes | See schedule formats below |
| `context_mode` | string | no | `isolated` (default) or `group` |
| `taskId` | string | no | Custom ID (auto-generated if omitted) |

**Schedule formats**:
- `cron`: Standard cron expression (e.g., `"0 9 * * 1-5"` for weekdays 9am)
- `interval`: Milliseconds (e.g., `"3600000"` for hourly)
- `once`: ISO timestamp (e.g., `"2026-03-25T15:00:00Z"`)

**Authorization**: Main group can schedule for any registered chat. Non-main groups can only schedule for themselves.

---

### Pause Task

```json
{
  "type": "pause_task",
  "taskId": "task-12345-abc"
}
```

**Authorization**: Main group can pause any task. Non-main groups can only pause their own tasks.

---

### Resume Task

```json
{
  "type": "resume_task",
  "taskId": "task-12345-abc"
}
```

**Authorization**: Same as pause.

---

### Cancel Task

```json
{
  "type": "cancel_task",
  "taskId": "task-12345-abc"
}
```

Permanently deletes the task and its run logs.

**Authorization**: Same as pause.

---

### Update Task

```json
{
  "type": "update_task",
  "taskId": "task-12345-abc",
  "prompt": "Updated prompt text",
  "schedule_type": "cron",
  "schedule_value": "0 10 * * *"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"update_task"` |
| `taskId` | string | yes | Task to update |
| `prompt` | string | no | New prompt |
| `schedule_type` | string | no | New schedule type |
| `schedule_value` | string | no | New schedule value |

Note: Changing schedule values recalculates `next_run` automatically.

**Authorization**: Same as pause.

---

## Group Management Operations

### Register Group

**Main group only** — creates a new registered group.

```json
{
  "type": "register_group",
  "jid": "120363xxxxxxxxx@g.us",
  "name": "My Group Name",
  "folder": "my-group",
  "trigger": "!bot",
  "requiresTrigger": true,
  "containerConfig": {
    "model": "claude-sonnet-4-6"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | `"register_group"` |
| `jid` | string | yes | Chat JID to register |
| `name` | string | yes | Display name |
| `folder` | string | yes | Group folder name (alphanumeric, dash, underscore) |
| `trigger` | string | yes | Trigger pattern (regex) |
| `requiresTrigger` | boolean | no | Whether trigger is required (default: true) |
| `containerConfig` | object | no | Container configuration overrides |

---

### Refresh Groups

**Main group only** — triggers a metadata sync from messaging channels.

```json
{
  "type": "refresh_groups"
}
```

---

## Database Tables (Read-Only Access)

The Express server can read directly from `STORE_DIR/messages.db`:

### `chats`
| Column | Type | Description |
|--------|------|-------------|
| `jid` | TEXT PK | Chat identifier |
| `name` | TEXT | Display name |
| `last_message_time` | TEXT | ISO timestamp |
| `channel` | TEXT | `whatsapp`, `telegram`, `discord`, etc. |
| `is_group` | INTEGER | 1 for groups, 0 for DMs |

### `messages`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Message ID |
| `chat_jid` | TEXT FK | Chat reference |
| `sender` | TEXT | Sender JID |
| `sender_name` | TEXT | Sender display name |
| `content` | TEXT | Message content |
| `timestamp` | TEXT | ISO timestamp |
| `is_from_me` | INTEGER | 1 if sent by bot |
| `is_bot_message` | INTEGER | 1 if bot response |

### `scheduled_tasks`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Task identifier |
| `group_folder` | TEXT | Associated group |
| `chat_jid` | TEXT | Target chat |
| `prompt` | TEXT | Agent prompt |
| `schedule_type` | TEXT | `cron`, `interval`, `once` |
| `schedule_value` | TEXT | Schedule definition |
| `context_mode` | TEXT | `isolated` or `group` |
| `next_run` | TEXT | Next execution time |
| `last_run` | TEXT | Last execution time |
| `last_result` | TEXT | Result summary |
| `status` | TEXT | `active`, `paused`, `completed` |
| `created_at` | TEXT | Creation timestamp |

### `task_run_logs`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Log entry ID |
| `task_id` | TEXT FK | Task reference |
| `run_at` | TEXT | Execution timestamp |
| `duration_ms` | INTEGER | Execution duration |
| `status` | TEXT | `success` or `error` |
| `result` | TEXT | Result text |
| `error` | TEXT | Error message if failed |

### `registered_groups`
| Column | Type | Description |
|--------|------|-------------|
| `jid` | TEXT PK | Chat JID |
| `name` | TEXT | Display name |
| `folder` | TEXT | Group folder path |
| `trigger_pattern` | TEXT | Trigger regex |
| `added_at` | TEXT | Registration timestamp |
| `container_config` | TEXT | JSON config |
| `requires_trigger` | INTEGER | Trigger required flag |
| `is_main` | INTEGER | Main group flag |

### `error_log`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Log entry ID |
| `level` | TEXT | `error`, `fatal`, or `warn` |
| `message` | TEXT | Log message |
| `context` | TEXT | JSON context object |
| `timestamp` | TEXT | ISO timestamp |

### `sessions`
| Column | Type | Description |
|--------|------|-------------|
| `group_folder` | TEXT PK | Group folder |
| `session_id` | TEXT | Active session ID |

---

## Example: Dashboard Integration

```typescript
// Express server writes task to IPC
import { writeFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

const DATA_DIR = process.env.NANOCLAW_DATA_DIR || '~/.nanoclaw/data';
const ipcDir = `${DATA_DIR}/ipc/dashboard/tasks`;

function scheduleDashboardTask(targetJid: string, prompt: string, cron: string) {
  mkdirSync(ipcDir, { recursive: true });

  const task = {
    type: 'schedule_task',
    targetJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: cron,
    context_mode: 'isolated'
  };

  writeFileSync(
    `${ipcDir}/${randomUUID()}.json`,
    JSON.stringify(task)
  );
}

// Usage
scheduleDashboardTask(
  '120363xxxxxxxxx@g.us',
  'Post daily standup reminder',
  '0 9 * * 1-5'  // Weekdays at 9am
);
```

---

## Error Handling

Failed IPC messages are moved to `DATA_DIR/ipc/errors/` with the source group prefixed:

```
errors/
├── dashboard-abc123.json    # Failed message from dashboard group
└── main-def456.json         # Failed message from main group
```

Check NanoClaw logs for error details:
```bash
tail -f ~/.nanoclaw/logs/nanoclaw.log | grep IPC
```