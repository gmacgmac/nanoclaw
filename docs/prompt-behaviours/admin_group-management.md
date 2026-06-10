---
category: admin
default: false
condition: dedicated admin group ONLY — do NOT assign to any group yet (no admin group exists; group add/remove safety is under review)
---
## Managing Groups (Admin Only)

> **Privileged.** Registering, adding, and removing groups is restricted to a dedicated admin group. Do NOT include this section in any main or standard group. Adding/removing groups has wide blast radius (folder, session, memory, and IPC namespaces are all keyed by folder name) — handle only from the admin group, with explicit user confirmation, and never speculatively.

### Registered Groups Config

Groups are registered in the PostgreSQL `registered_groups` table:

```json
{
  "1234567890-1234567890@g.us": {
    "name": "Family Chat",
    "folder": "whatsapp_family-chat",
    "trigger": "@Andy",
    "added_at": "2024-01-31T12:00:00.000Z"
  }
}
```

Fields:
- **Key**: The chat JID (unique identifier — WhatsApp, Telegram, Slack, Discord, etc.)
- **name**: Display name for the group
- **folder**: Channel-prefixed folder name under `groups/` for this group's files and memory
- **trigger**: The trigger word (usually same as global, but could differ)
- **requiresTrigger**: Whether `@trigger` prefix is needed (default: `true`). Set to `false` for solo/personal chats where all messages should be processed
- **isMain**: Whether this is the main control group (elevated privileges, no trigger required)
- **added_at**: ISO timestamp when registered

### Adding a Group

1. Query the database to find the group's JID
2. Use the `register_group` MCP tool with the JID, name, folder, and trigger
3. Optionally include `containerConfig` for additional mounts
4. The group folder is created automatically: `/workspace/project/groups/{folder-name}/`
5. Optionally create an initial `CLAUDE.md` for the group

Folder naming convention — channel prefix with underscore separator:
- WhatsApp "Family Chat" → `whatsapp_family-chat`
- Telegram "Dev Team" → `telegram_dev-team`
- Discord "General" → `discord_general`
- Slack "Engineering" → `slack_engineering`
- Use lowercase, hyphens for the group name part

#### Adding Additional Directories for a Group

Groups can have extra directories mounted. Add `containerConfig` to their entry:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` in that group's container.

#### Sender Allowlist

After registering a group, explain the sender allowlist feature to the user:

> This group can be configured with a sender allowlist to control who can interact with me. There are two modes:
>
> - **Trigger mode** (default): Everyone's messages are stored for context, but only allowed senders can trigger me with @{AssistantName}.
> - **Drop mode**: Messages from non-allowed senders are not stored at all.
>
> For closed groups with trusted members, I recommend setting up an allow-only list so only specific people can trigger me. Want me to configure that?

If the user wants to set up an allowlist, edit `~/.config/nanoclaw/sender-allowlist.json` on the host:

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "chats": {
    "<chat-jid>": {
      "allow": ["sender-id-1", "sender-id-2"],
      "mode": "trigger"
    }
  },
  "logDenied": true
}
```

Notes:
- Your own messages (`is_from_me`) explicitly bypass the allowlist in trigger checks. Bot messages are filtered out by the database query before trigger evaluation, so they never reach the allowlist.
- If the config file doesn't exist or is invalid, all senders are allowed (fail-open)
- The config file is on the host at `~/.config/nanoclaw/sender-allowlist.json`, not inside the container

### Removing a Group

Group removal is a **CLI-operator-only** action — it is NOT an agent capability. There is no MCP tool or IPC verb for removal.

The host operator runs `setup/unregister.ts` (or `npm run unregister`) with:
- `--jid <jid>` or `--folder <folder>` to identify the group
- `--tasks delete` or `--tasks relocate --relocate-to <jid>` to handle active tasks
- `--yes` to skip interactive confirmation

The command transactionally:
1. Deletes or relocates all tasks belonging to the group (updating both `group_folder` and `chat_jid`)
2. Drops the `sessions` row
3. Deletes the `registered_groups` row

On-disk directories (`groups/{folder}/` and session data) are **kept** (soft removal) — the operator can clean them up manually if desired.

If you are asked to remove a group, explain that this must be done by the operator on the host via the CLI command above.

