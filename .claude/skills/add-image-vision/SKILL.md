---
name: add-image-vision
description: Image vision support for NanoClaw agents. When a group's preset has capabilities.vision enabled, agents receive images as multimodal content blocks and can send attachments back via the send_attachment MCP tool.
---

# Image Vision

NanoClaw agents can see and understand images sent by users when the group's resolved preset has `capabilities.vision: true`. Images are resized, normalized, and passed to the agent as base64-encoded multimodal content blocks.

## Prerequisites

- The group must use a preset with `"capabilities": { "vision": true }` in `~/.config/nanoclaw/model-presets.json`
- `sharp` must be installed (`npm ls sharp` to verify)

## How It Works

### Inbound Images (User → Agent)

1. **Image extraction**: The message loop matches `[Photo]: /path caption` patterns in incoming messages
2. **Vision gate**: Images are only processed when the resolved preset's `capabilities.vision` is `true`
3. **Encoding pipeline** (`src/image.ts`):
   - Validates file exists and is a supported format (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`)
   - Resizes to fit within 1568×1568px (Claude's recommended max), maintaining aspect ratio, without upscaling
   - Normalizes to JPEG at 85% quality
   - Base64 encodes the result
4. **Payload limit**: 10MB total per message batch — images are truncated if exceeded
5. **Delivery**: Images are passed via `ContainerInput.images` to the container, where the agent-runner builds multimodal content blocks using `pushMultimodal()`

### IPC Piped Images

When images arrive while a container is already running, they are piped via IPC JSON with an `images` array field. The agent-runner uses `pushMultimodal()` to inject them into the active conversation.

### Outbound Attachments (Agent → User)

Agents can send files back to users via the `send_attachment` MCP tool:

```
mcp__nanoclaw__send_attachment(
  file_path="/workspace/group/media/chart.png",
  caption="Here's the chart you requested"
)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Absolute path within `/workspace/group/` |
| `caption` | string | no | Caption/description sent with the file |
| `target_jid` | string | no | (Main group only) Target group JID |

**Security**: The file must exist within `/workspace/group/`. Path traversal is blocked.

**Host resolution**: The container path (`/workspace/group/media/file.jpg`) is resolved to the host path (`groups/{folder}/media/file.jpg`) by the IPC handler before routing to the channel.

**Channel routing** (Telegram): Files are sent as photo (jpg/png/webp/gif), video (mp4/mov/avi/mkv), or document (everything else) based on extension.

## Enabling Vision for a Group

1. Ensure the group's preset has vision enabled:
   ```json
   {
     "sonnet_4.5": {
       "endpoint": "anthropic",
       "model": "claude-sonnet-4-5-20250514",
       "capabilities": { "vision": true, "tools": true },
       "contextWindow": 200000
     }
   }
   ```

2. Assign the preset to the group via `/model sonnet_4.5` or by setting `containerConfig.preset` directly.

## Troubleshooting

- **Agent doesn't mention image content**: Check that the group's preset has `capabilities.vision: true`. Check container logs for "Loaded image" messages.
- **"Image - processing failed"**: Sharp may not be installed correctly. Run `npm ls sharp` to verify.
- **send_attachment fails**: Ensure the file path is absolute and within `/workspace/group/`. Check that the file exists in the container.

## Key Files

| File | Purpose |
|------|---------|
| `src/image.ts` | Image encoding pipeline (resize, normalize, base64) |
| `src/presets.ts` | Preset resolution — `capabilities.vision` gate |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | `send_attachment` MCP tool registration |
| `src/ipc.ts` | Host-side attachment IPC handling |
| `src/types.ts` | `ContainerInput.images`, `Channel.sendAttachment` |
