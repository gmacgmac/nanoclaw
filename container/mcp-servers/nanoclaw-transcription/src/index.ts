/**
 * NanoClaw Transcription MCP Server
 * Exposes a transcribe_audio tool that routes through the host credential proxy
 * to run local whisper.cpp. No API keys needed — runs entirely on-device.
 *
 * Environment variables (set by container-runner):
 *   NANOCLAW_PROXY_HOST — credential proxy host (e.g. host.docker.internal)
 *   NANOCLAW_PROXY_PORT — credential proxy port (default: 3001)
 *
 * Security: No secrets hardcoded. All errors to stderr. Stdout is MCP protocol only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function getProxyUrl(path: string): string {
  const host = process.env.NANOCLAW_PROXY_HOST || 'host.docker.internal';
  const port = process.env.NANOCLAW_PROXY_PORT || '3001';
  return `http://${host}:${port}${path}`;
}

interface TranscriptionResponse {
  text?: string;
  error?: string;
}

async function transcribeAudio(audioPath: string): Promise<string> {
  const url = getProxyUrl('/transcribe');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioPath }),
  });

  if (!response.ok) {
    const data = (await response.json()) as { error?: string };
    throw new Error(data.error || `Transcription failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as TranscriptionResponse;
  if (data.error) {
    throw new Error(data.error);
  }
  if (!data.text) {
    throw new Error('No transcription returned');
  }

  return data.text;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'nanoclaw-transcription',
  version: '1.0.0',
});

server.tool(
  'transcribe_audio',
  `Transcribe an audio file to text using local whisper.cpp (on-device, no API calls).

WHEN TO USE:
- Every voice message you receive arrives as a file path — transcribe it before responding to its content.
- Any audio file the user references (e.g. "what did I say in this recording?").
- Never transcribe the same file twice in one turn; cache the result in context.

ARGUMENT:
- audioPath: the full container path exactly as received (e.g. "/workspace/group/media/2026-04-28T11-56-00_attachment.oga")
  Do not modify or guess the path. Pass it verbatim.

HOW IT WORKS:
1. The path is sent to the host-side credential proxy.
2. The proxy resolves the container path to the real file on the host filesystem.
3. ffmpeg converts the audio to WAV 16kHz mono.
4. whisper-cli (using the ggml-small.bin model) transcribes it to text.
5. The transcript is returned as plain text.

DO NOT run ffmpeg or whisper-cli directly inside the container — those binaries are on the host, not in the image. Always route through this MCP tool.

COMMON ERRORS:
- "spawn ffmpeg ENOENT" or "spawn whisper-cli ENOENT": the host service does not have /opt/homebrew/bin (or /usr/local/bin) on its PATH. The admin needs to fix the launchd plist (bootout + bootstrap, not kickstart -k).
- "Model not found: ...": the GGML model file is missing from data/models/ on the host.
- "Transcription failed: HTTP ...": the credential proxy is not running or the /transcribe endpoint is unreachable from the container.`,
  {
    audioPath: z
      .string()
      .describe('Absolute path to the audio file inside the container. Pass the path exactly as received, unmodified.'),
  },
  async (args) => {
    try {
      const text = await transcribeAudio(args.audioPath);
      return {
        content: [
          { type: 'text' as const, text: `Transcription:\n\n${text}` },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nanoclaw-transcription] error: ${message}\n`);
      return {
        content: [
          { type: 'text' as const, text: `Transcription failed: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
