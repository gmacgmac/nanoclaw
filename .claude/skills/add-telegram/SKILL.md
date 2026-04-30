---
name: add-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/telegram.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Check for existing bot

Check if `TELEGRAM_BOT_TOKEN` is already set in `~/.config/nanoclaw/secrets.env`:

```bash
grep -q "^TELEGRAM_BOT_TOKEN=" ~/.config/nanoclaw/secrets.env && echo "EXISTS" || echo "MISSING"
```

If it **already exists**, ask the user:

AskUserQuestion: A Telegram bot is already configured. Is this a secondary bot, or do you want to replace the existing one?

- If **replace**: proceed with the existing flow below (Phase 3 onwards). The new token will overwrite `TELEGRAM_BOT_TOKEN`.
- If **secondary**: the user is adding a new bot alongside the existing one. Guide them through creating a new bot via BotFather (Phase 3). The secondary bot token will use a different env var name.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Telegram bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `telegram` is missing, add it:

```bash
git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
```

### Merge the skill branch

```bash
git fetch telegram main
git merge telegram/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/telegram.ts` (TelegramChannel class with self-registration via `registerChannel`)
- `src/channels/telegram.test.ts` (unit tests with grammy mock)
- `import './telegram.js'` appended to the channel barrel file `src/channels/index.ts`
- `grammy` npm dependency in `package.json`
- `TELEGRAM_BOT_TOKEN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/telegram.test.ts
```

All tests must pass (including the new Telegram tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Telegram Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Telegram bot:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Andy Assistant")
>    - Bot username: Must end with "bot" (e.g., "andy_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

Wait for the user to provide the token.

### Configure environment

For the **first bot**, add to `~/.config/nanoclaw/secrets.env`:

```bash
TELEGRAM_BOT_TOKEN=<their-token>
```

For **secondary bots**, use the naming convention `TELEGRAM_{BOT_NAME}_BOT_TOKEN`:

```bash
TELEGRAM_CHOC_BOT_TOKEN=7906558245:AAGrFa1yMiTpAcC7q2A5r_gF0d1bb5cN0kQ
```

For example, if the bot is named "chocbot", add `TELEGRAM_CHOC_BOT_TOKEN`. The bot name ("chocbot") will be passed during registration via `--bot-token-name chocbot`.

If `~/.config/nanoclaw/secrets.env` doesn't exist, tell the user to run `/setup` first (which creates the template).

Channels auto-enable when their credentials are present — no extra configuration needed.

### Disable Group Privacy (for group chats)

Tell the user:

> **Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> This is optional if you only want trigger-based responses via @mentioning the bot.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open your bot in Telegram (search for its username)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group

Wait for the user to provide the chat ID.

- For the **default bot**, `/chatid` outputs a plain JID: `tg:123456789`
- For a **named bot** (e.g. `@chocalotbot`), `/chatid` outputs a virtual JID: `tg:123456789:choc`

Copy the `/chatid` output verbatim into the registration command — no manual transformation needed.

### Register the chat

The chat ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "tg:123456789" --name "<chat-name>" --folder "telegram_main" --trigger "@${ASSISTANT_NAME}" --channel telegram --endpoint <provider> --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "tg:123456789" --name "<chat-name>" --folder "telegram_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel telegram --endpoint <provider>
```

For secondary bots (using a bot other than the default `TELEGRAM_BOT_TOKEN`), add `--bot-token-name` and use the virtual JID from `/chatid`:

```bash
npx tsx setup/index.ts --step register -- --jid "tg:6013943815:choc" --name "GM Choc" --folder "choc_main" --trigger "@${ASSISTANT_NAME}" --channel telegram --endpoint <provider> --bot-token-name choc
```

`<provider>` must match a vendor prefix in `secrets.env` (e.g. `ollama`, `anthropic`, `zai`).

The `--bot-token-name` value must match the `{NAME}` part of the `TELEGRAM_{NAME}_BOT_TOKEN` env var in `secrets.env`. It is case-insensitive, so `choc` matches `TELEGRAM_CHOC_BOT_TOKEN`.

**Important:** Use the virtual JID exactly as `/chatid` outputs it. Do not manually add or remove the `:botName` suffix — `/chatid` is the source of truth.

## Phase 5: Group Setup

After registration, set up the group's CLAUDE.md, memory directory, and formatting skill. This ensures the agent has instructions and memory from its very first message.

### A. Create CLAUDE.md from template

Check if `groups/<folder>/CLAUDE.md` already exists:

```bash
test -f groups/<folder>/CLAUDE.md && echo "EXISTS" || echo "MISSING"
```

If it exists, tell the user: "CLAUDE.md already exists for this group — skipping template copy."

If missing, copy the appropriate template:

- For main groups (registered with `--is-main`):
  ```bash
  cp groups/main/CLAUDE.md groups/<folder>/CLAUDE.md
  ```

- For non-main groups:
  ```bash
  cp groups/global/CLAUDE.md groups/<folder>/CLAUDE.md
  ```

After copying, tell the user: "Created `groups/<folder>/CLAUDE.md` from the template. You should edit this file to customise the agent's identity and add any group-specific instructions."

### B. Create memory directory and seed files

```bash
mkdir -p groups/<folder>/memory
```

Check and create each seed file only if missing:

```bash
test -f groups/<folder>/memory/MEMORY.md || echo "# Memory" > groups/<folder>/memory/MEMORY.md
test -f groups/<folder>/memory/COMPACT.md || echo "# Compact" > groups/<folder>/memory/COMPACT.md
```

If files already exist, tell the user: "Memory seed files already exist — skipping."

### C. Set formatting skill in containerConfig

Telegram uses Markdown v1 which differs from standard Markdown. Add the `telegram-formatting` skill to the group's containerConfig:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(container_config, '$.skills', json('[\"capabilities\", \"status\", \"telegram-formatting\"]')) WHERE folder = '<folder>'"
```

Then clear the skills cache so the new skill is loaded on next container spawn:

```bash
rm -rf data/sessions/<folder>/.claude/skills
```

Do not duplicate formatting rules in CLAUDE.md — the skill is the single source of truth.

Also add response delivery guidance to the group's `CLAUDE.md`:

```markdown
For normal replies, respond with text. Your text output is delivered directly to Telegram.
Only use mcp__nanoclaw__send_message for mid-run progress updates or cross-group delegation.
If you call send_message, wrap any follow-up text in <internal> tags so it is not delivered:
<internal>Done.</internal>
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message to your registered Telegram chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> The bot should respond within a few seconds.
>
> **Voice messages:** If transcription is enabled (`/add-transcription` skill applied), send a voice note. The agent should receive it as `[Voice: <transcript>]` and respond to its content.
>
> **Audio files:** Regular audio files (MP3, etc.) are delivered as `[Audio]: <filepath>` — transcription is only applied to voice messages (OGG/Opus) by default. Agents can call `transcribe_audio` manually on any audio file if the transcription MCP is configured.

### Verify the correct bot responded (secondary bots)

If this is a secondary bot registration, confirm the response came from the expected bot username. The group is tied to a specific bot via `--bot-token-name` and the `TELEGRAM_{NAME}_BOT_TOKEN` env var. If the wrong bot replies, the group may be falling back to the default bot.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `TELEGRAM_BOT_TOKEN` is set in `~/.config/nanoclaw/secrets.env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Secondary bot not responding

If a secondary bot (registered with `--bot-token-name`) is not responding:

1. Check the correct `TELEGRAM_{NAME}_BOT_TOKEN` is in `~/.config/nanoclaw/secrets.env`. For example, if `--bot-token-name choc` was used, `TELEGRAM_CHOC_BOT_TOKEN` must be set.
2. Check `--bot-token-name` matches the `{NAME}` part exactly. Matching is case-insensitive, so `choc` matches `TELEGRAM_CHOC_BOT_TOKEN`.
3. Check the group's JID includes the bot name suffix (e.g. `tg:123456:choc`). The JID itself is the primary routing key — if it has the wrong suffix or no suffix, the wrong bot (or default bot) may handle the message.
4. Check the group's `container_config` has the correct `telegramBot` value:
   ```bash
   sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<folder>'"
   ```
   The output should include `"telegramBot":"choc"` (or the equivalent name). This is used as a fallback for plain JIDs without a suffix.

### Wrong bot responding

If the wrong bot replies to a message:

1. Check the group's JID — it should match the bot that received the message. For a named bot, the JID must include `:botName` (e.g. `tg:123456:choc`).
2. If the JID suffix and `containerConfig.telegramBot` disagree, NanoClaw logs a warning and uses the JID suffix. Re-register the group using the correct `/chatid` output to fix the JID.

### Bot only responds to @mentions in groups

Group Privacy is enabled (default). Fix:
1. `@BotFather` > `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
2. Remove and re-add the bot to the group (required for the change to take effect)

### Getting chat ID

If `/chatid` doesn't work:
- Verify token: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/nanoclaw.log`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Voice Message Transcription

After completing Telegram setup, voice messages are supported. NanoClaw can automatically transcribe them using local whisper.cpp so the agent receives `[Voice: <transcript>]` instead of just a file path.

**Prerequisites:** `whisper-cpp` and `ffmpeg` installed via Homebrew, plus a GGML model file at `data/models/`.

Use `AskUserQuestion`:

AskUserQuestion: Would you like to enable local voice transcription for this Telegram group? This uses whisper.cpp running on your Mac — no cloud, no API keys, no cost.

If they say yes, invoke the `/add-transcription` skill. After applying it:
1. The transcription MCP server is built into the container image
2. Voice messages arriving in Telegram are auto-transcribed before the agent sees them
3. Agents can also proactively call `transcribe_audio` on any audio file they encounter

The transcription feature is **contingent on the credential proxy endpoint** (`POST /transcribe`) being available. The host service must be restarted after applying the skill for the proxy to load the new endpoint.

## Agent Swarm (Teams)

After completing the Telegram setup, use `AskUserQuestion`:

AskUserQuestion: Would you like to add Agent Swarm support? Without it, Agent Teams still work — they just operate behind the scenes. With Swarm support, each subagent appears as a different bot in the Telegram group so you can see who's saying what and have interactive team sessions.

If they say yes, invoke the `/add-telegram-swarm` skill.

## Removal

To remove Telegram integration:

1. Delete `src/channels/telegram.ts` and `src/channels/telegram.test.ts`
2. Remove `import './telegram.js'` from `src/channels/index.ts`
3. Remove or comment out `TELEGRAM_BOT_TOKEN` in `~/.config/nanoclaw/secrets.env`
4. Remove Telegram registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
5. Uninstall: `npm uninstall grammy`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
