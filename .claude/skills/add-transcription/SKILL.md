---
name: add-transcription
description: Add local audio transcription to NanoClaw using whisper.cpp. Agents transcribe audio files on demand via the `transcribe_audio` MCP tool. Runs entirely on-device — no API keys, no cloud, no cost.
---

# Add Transcription

This skill adds local audio transcription to NanoClaw using whisper.cpp (via Homebrew). Agents call the `transcribe_audio` MCP tool to transcribe any audio file they receive.

**Architecture:**
- **Host-side:** `src/transcription.ts` calls `whisper-cli` + `ffmpeg` directly
- **Credential proxy:** `POST /transcribe` endpoint receives paths from containers, resolves them to host paths, runs transcription
- **Container MCP:** `nanoclaw-transcription` server exposes `transcribe_audio` tool; agents invoke it with a file path

**Flow:**
1. Agent receives an audio file path (e.g. `[Voice]: /workspace/group/media/2026-04-28T11-56-00_attachment.oga`)
2. Agent calls `mcp__nanoclaw__transcription__transcribe_audio` with the path
3. MCP server sends the path to the host proxy via HTTP
4. Proxy resolves the container path to a host path, runs `ffmpeg` → `whisper-cli`, returns text
5. Agent receives the transcript

**Prerequisites:**
- macOS with Apple Silicon (M1+) recommended
- `whisper-cpp` installed: `brew install whisper-cpp`
- `ffmpeg` installed: `brew install ffmpeg`
- A GGML model file (e.g. `ggml-small.bin`, ~466MB) at `data/models/`

## Phase 1: Pre-flight

### Check if already applied

Check if `src/transcription.ts` exists:

```bash
test -f src/transcription.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Enable for Groups).

### Check dependencies

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing, install via Homebrew:
```bash
brew install whisper-cpp ffmpeg
```

### Check for model file

```bash
ls data/models/ggml-*.bin 2>/dev/null || echo "NO_MODEL"
```

If no model exists, download one:
- **Base** (148MB, fast): `curl -L -o data/models/ggml-base.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"`
- **Small** (466MB, balanced): `curl -L -o data/models/ggml-small.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"`
- **Medium** (1.5GB, accurate): `curl -L -o data/models/ggml-medium.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"`

Or place the model file manually at `data/models/ggml-<size>.bin`.

## Phase 2: Apply Code Changes

The transcription feature is already in `main` if the code changes are present. If not, the changes include:

- `src/transcription.ts` — host-side transcription module
- `src/transcription.test.ts` — unit tests
- `src/credential-proxy.ts` — `POST /transcribe` endpoint
- `container/mcp-servers/nanoclaw-transcription/` — MCP server for containers
- `container/Dockerfile` — build step for the transcription MCP server
- `src/container-runner.ts` — injects proxy env vars for transcription MCP

### Validate

```bash
npm run build
npx vitest run src/transcription.test.ts
```

## Phase 3: Enable for Groups

### Enable transcription MCP for a group

The transcription MCP server must be added to each group's `containerConfig`:

```bash
sqlite3 store/messages.db "
UPDATE registered_groups SET container_config = json_set(container_config, '$.mcpServers.nanoclaw-transcription', json('{\"command\":\"node\",\"args\":[\"/app/mcp-servers/nanoclaw-transcription/dist/index.js\"]}'))
WHERE folder = '<group-folder>';
"
```

Repeat for each group that should have transcription access.

### Agent instructions

Add to the group's `CLAUDE.md` or `memory/MEMORY.md`:

```markdown
## Audio Transcription

When you receive a voice message or audio file, it arrives as a file path:
`[Voice]: /workspace/group/media/2026-04-28T11-56-00_attachment.oga`

Transcribe it using the local whisper.cpp tool:

**Tool:** `mcp__nanoclaw__transcription__transcribe_audio`

**Argument:** `audioPath` — the full container path exactly as received

**How it works:** The tool sends the path to the host-side proxy, which runs
`whisper-cli` using the `ggml-small.bin` model. No API calls, no cloud.

**Result:** Returns the transcribed text.

**When to use:** Always transcribe voice messages before responding to their content.
Can also transcribe any audio file the user references.

**Do not** run `ffmpeg` or `whisper-cli` directly inside the container — those binaries
are on the host. Always route through the MCP tool.
```

## Phase 4: Build and Restart

### Rebuild container image

The transcription MCP server is built into the Docker image. Rebuild after code changes:

```bash
./container/build.sh
```

### Restart host service

The credential proxy needs to load the new `/transcribe` endpoint:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 5: Verify

### Test MCP tool manually

Send a voice message in Telegram. The agent receives:
> `[Voice]: /workspace/group/media/2026-04-28T11-56-00_attachment.oga`

The agent should call `transcribe_audio` and return the transcript.

Check logs:
```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Transcribed voice message` — successful transcription
- `whisper.cpp transcription failed` — check model path, ffmpeg, or PATH
- `spawn ffmpeg ENOENT` — ffmpeg not on the service's PATH (see Phase 6)

## Phase 6: Ensure launchd PATH includes Homebrew

**This is critical.** The NanoClaw launchd service runs with a restricted PATH. `whisper-cli` and `ffmpeg` are installed in `/opt/homebrew/bin/` (Apple Silicon) or `/usr/local/bin/` (Intel). If that directory is not in the plist's PATH, transcription will fail with `spawn ffmpeg ENOENT` or `spawn whisper-cli ENOENT`.

Check the current PATH:
```bash
grep -A1 'PATH' ~/Library/LaunchAgents/com.nanoclaw.plist
```

If `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel) is missing, edit the plist:

```bash
# Apple Silicon (M1+)
launchctl bootout gui/$(id -u)/com.nanoclaw
# Edit ~/Library/LaunchAgents/com.nanoclaw.plist:
# Change <string>/usr/local/bin:/usr/bin:/bin:...</string>
# To:    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:...</string>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify the live process has the new PATH:
```bash
ps eww $(pgrep -f "dist/index.js" | head -1) | tr ' ' '\n' | grep "^PATH="
```

Expected: `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:...`

**Important:** `launchctl kickstart -k` does NOT pick up plist changes. You must `bootout` + `bootstrap` to reload the plist.

## Configuration

Environment variables (optional, set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-small.bin` | Path to GGML model file |

The transcription module uses `os.tmpdir()` for temporary WAV and output files, so no manual temp directory management is needed.

## Troubleshooting

### "Model not found: ..."

The model file is missing or not at the expected path. Check:
1. File exists: `ls -lh data/models/ggml-*.bin`
2. WHISPER_MODEL env var points to the right file (if set)

### "spawn ffmpeg ENOENT" or "spawn whisper-cli ENOENT"

The binaries are installed but not on the service's PATH. This is the most common failure mode. Fix:
1. Check binary locations: `which ffmpeg` and `which whisper-cli`
2. Check live process PATH: `ps eww $(pgrep -f "dist/index.js" | head -1) | grep PATH`
3. If the binary directory is missing, update the plist (see Phase 6)

### Transcription works in dev but not as service

The launchd plist PATH doesn't include `/opt/homebrew/bin`. See Phase 6.

### MCP tool returns "Transcription failed"

Check:
1. Service is running: `launchctl list | grep nanoclaw`
2. Proxy port is accessible from containers: `CREDENTIAL_PROXY_PORT` (default 3001)
3. Container has `NANOCLAW_PROXY_HOST` and `NANOCLAW_PROXY_PORT` env vars set
4. Check `logs/nanoclaw.error.log` for the actual error from the host proxy

### Slow transcription

The small model processes ~30s of audio in ~1s on M1+. If slower, check CPU usage. Switch to `ggml-base.bin` for faster (but slightly less accurate) transcription.

### Wrong language

whisper.cpp auto-detects language. To force a language, modify `src/transcription.ts` to pass `-l <lang>` or set a `WHISPER_LANG` env var and wire it through.

## Important: Credential Proxy Dependency

The `transcribe_audio` MCP tool **requires the credential proxy endpoint** (`POST /transcribe`) to be available. This endpoint is part of the host-side `src/credential-proxy.ts` and is loaded when the NanoClaw service starts.

If the proxy is not running or the endpoint is unreachable from containers, the MCP tool will fail with:
> `Transcription failed: Transcription failed: HTTP ...`

Always restart the service after applying this skill to ensure the proxy loads the new endpoint.

## Removal

To remove transcription:

1. Remove `nanoclaw-transcription` from group `containerConfig`:
   ```bash
   sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_remove(container_config, '$.mcpServers.nanoclaw-transcription') WHERE folder = '<group-folder>'"
   ```
2. Remove host-side code: `src/transcription.ts`, `src/transcription.test.ts`, and the `/transcribe` endpoint from `src/credential-proxy.ts`
3. Remove container MCP server: `container/mcp-servers/nanoclaw-transcription/`
4. Rebuild and restart
