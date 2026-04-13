---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Prerequisites

Check that required tools are installed before any setup work begins. Fail fast here rather than halfway through.

### 0-i. Node.js 20+

Run `node --version`.

- If missing or version < 20: AskUserQuestion: "Node.js 20+ is required. Would you like me to install it?"
  - macOS: `brew install node@22` (if brew available), otherwise install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
- Verify: `node --version` returns v20+ or v22+

### 0-ii. Docker

Run `docker --version` and `docker info`.

- If `docker` not found: AskUserQuestion: "Docker is required for running agent containers. Would you like me to help install it?"
  - macOS: `brew install --cask docker` (if brew available), then `open -a Docker`. If no brew, direct to https://docker.com/products/docker-desktop
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
- If installed but not running: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check.
- Verify: `docker info` returns without error

**Note:** Step 3 handles runtime selection (Docker vs Apple Container) and building. This check just ensures Docker is available on the system before we invest time in bootstrap and environment checks.

## 0a. Git & Fork Setup

Check the git remote configuration. The `gmacgmac/nanoclaw` fork is the actively maintained version and should be the primary `origin`.

Run `git remote -v`.

**Case A — No git repo (fresh clone needed):**

AskUserQuestion: "How did you get this code? If you haven't cloned yet, I can set that up."

If they haven't cloned:
```bash
git clone https://github.com/gmacgmac/nanoclaw.git ~/.nanoclaw
```

After clone, optionally add upstream for tracking the original repo:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case B — `origin` points to `qwibitai/nanoclaw`:**

AskUserQuestion: "Your origin points to the original qwibitai repo. The gmacgmac fork is the actively maintained version. Would you like to switch?"

If yes:
```bash
git remote rename origin upstream
git remote add origin https://github.com/gmacgmac/nanoclaw.git
```

If no: continue — they may have their own reasons.

**Case C — `origin` points to `gmacgmac/nanoclaw` (or user's own fork of it):**

Check for `upstream`:
- If no upstream: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- If upstream exists: already configured, continue

**Case D — `origin` points to user's own fork (not gmacgmac, not qwibitai):**

AskUserQuestion: "Your origin points to your own fork. Is this forked from gmacgmac/nanoclaw?"

- If yes: ensure upstream is set to `https://github.com/qwibitai/nanoclaw.git`
- If no: warn that the setup is designed for the gmacgmac fork and may not work correctly

**Verify:** `git remote -v` should show `origin` → gmacgmac (or user's fork of it), optionally `upstream` → `qwibitai/nanoclaw.git`.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 3c
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

**All secrets go in `~/.config/nanoclaw/secrets.env`, NOT in `.env`.** The `.env` file is for non-sensitive config only (like `TZ=Europe/London`). This keeps secrets out of the git repo.

### 4a. Check for existing secrets.env

```bash
test -f ~/.config/nanoclaw/secrets.env && echo "EXISTS" || echo "NOT_FOUND"
```

**If EXISTS:** Tell the user the file already exists at `~/.config/nanoclaw/secrets.env`. Ask: "Your secrets.env already exists. Would you like to review or edit it, or keep it as-is?" Do NOT read or display the file contents. If they want to edit, tell them to open it in their editor. Then skip to 4c.

**If NOT_FOUND:** Proceed to 4b.

### 4b. Write secrets.env template

Create the directory and write the template:

```bash
mkdir -p ~/.config/nanoclaw && chmod 700 ~/.config/nanoclaw
cat > ~/.config/nanoclaw/secrets.env << 'EOF'
# NanoClaw secrets — powers the credential proxy for agent containers
# Priority: this file > .env > process.env
# NOTE: This file does NOT affect the Claude Code instance running /setup.
#       It only controls how agent containers authenticate with model providers.

# === Auth Mode Anchor (REQUIRED) ===
# Must be present even if not using Anthropic as a provider.
# Without this, containers default to OAuth mode and hang on non-Anthropic endpoints.
# Use your real Anthropic key if you have one, otherwise leave as "placeholder".
ANTHROPIC_API_KEY=placeholder

# === Model Provider: Anthropic (uncomment if using Anthropic directly) ===
#ANTHROPIC_BASE_URL=https://api.anthropic.com
# If using Anthropic, replace "placeholder" above with your real API key.

# === Model Provider: Ollama ===
# Ollama v0.14.0+ exposes an Anthropic-compatible API
# Supports local models + Ollama Cloud (GLM, Kimi, Minimax)
# IMPORTANT: No /v1 suffix — the SDK adds it automatically
#OLLAMA_BASE_URL=http://localhost:11434
#OLLAMA_API_KEY=ollama

# === Model Provider: Z.ai ===
# Z.ai serves GLM-5.1, GLM-5, GLM-4.7, GLM-4.7-flash, GLM-4.5-air
#ZAI_BASE_URL=https://api.z.ai/api/anthropic
#ZAI_API_KEY=

# === Web Search (for non-Anthropic endpoints) ===
# Required if using nanoclaw-web-search MCP server
# Include the API path prefix — MCP server appends /web_search or /web_fetch
#OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api
#OLLAMA_WEB_SEARCH_API_KEY=

# === Channel Tokens ===
#TELEGRAM_BOT_TOKEN=
#SLACK_BOT_TOKEN=
#SLACK_APP_TOKEN=
#DISCORD_BOT_TOKEN=
EOF
chmod 600 ~/.config/nanoclaw/secrets.env
```

Tell the user: "Created `~/.config/nanoclaw/secrets.env` with a template. The `ANTHROPIC_API_KEY=placeholder` line is intentional — it prevents containers from defaulting to OAuth mode. Do not remove it unless you are replacing it with a real key or an OAuth token."

### 4c. Provider selection

AskUserQuestion: "Which provider will you use for the agent?"
- Ollama (local or Ollama Cloud)
- Z.ai
- Anthropic (direct API key)
- Anthropic Subscription (OAuth token)

Tell the user to open `~/.config/nanoclaw/secrets.env` in their editor and make the changes below. Do NOT read or write the file yourself at this point.

**Ollama:**
- Ensure Ollama is running: `ollama list`
- Uncomment `OLLAMA_BASE_URL` and `OLLAMA_API_KEY` in secrets.env.
- **Important:** The URL must NOT have a `/v1` suffix — the SDK adds it automatically. Use `http://localhost:11434` only.
- The `ANTHROPIC_API_KEY=placeholder` line must remain as-is.

**Z.ai:**
- Uncomment `ZAI_BASE_URL` and `ZAI_API_KEY`. Fill in their API key.
- The `ANTHROPIC_API_KEY=placeholder` line must remain as-is.

**Anthropic direct:**
- Uncomment `ANTHROPIC_BASE_URL`.
- Replace `placeholder` in `ANTHROPIC_API_KEY` with their real Anthropic API key.

**Subscription (OAuth):**
- Tell user to run `claude setup-token` in another terminal and copy the token.
- Replace the entire `ANTHROPIC_API_KEY=placeholder` line with: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
- Note: this disables api-key mode — the placeholder line must be removed, not kept alongside the token.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `~/.config/nanoclaw/secrets.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 6a. Sender Allowlist

Create `~/.config/nanoclaw/sender-allowlist.json` to restrict who can message the bot. This is critical for security on public channels like Telegram.

AskUserQuestion: "Who should be allowed to send messages to this bot?"

**Just me:** Ask for their Telegram user ID (tell them to message @RawDataBot on Telegram to get it). Create:
```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/sender-allowlist.json << 'EOF'
{
  "default": {
    "allow": ["<THEIR_USER_ID>"],
    "mode": "drop"
  },
  "chats": {},
  "logDenied": true
}
EOF
chmod 600 ~/.config/nanoclaw/sender-allowlist.json
```

**Anyone:** Create an open allowlist:
```bash
cat > ~/.config/nanoclaw/sender-allowlist.json << 'EOF'
{
  "default": {
    "allow": [],
    "mode": "allow"
  },
  "chats": {},
  "logDenied": false
}
EOF
chmod 600 ~/.config/nanoclaw/sender-allowlist.json
```

**Note:** The `mode: "drop"` silently ignores messages from non-allowlisted senders. `mode: "allow"` lets everyone through.

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (ensure secrets.env has vendor keys like `OLLAMA_API_KEY` or `ZAI_API_KEY`)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`
- SENDER_ALLOWLIST=missing → re-run step 6a (create sender-allowlist.json)

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing `secrets.env` (step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `~/.config/nanoclaw/secrets.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `secrets.env`. Restart the service after any `secrets.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`


## 9. Diagnostics

Send diagnostics data by following `.claude/skills/setup/diagnostics.md`.
