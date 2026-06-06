/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, AbortError } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

import { buildNudgePrompt } from './lib/nudge-prompt.js';
import { runPostTurnChecks } from './lib/post-turn-checks.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isAdmin: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  // Agent customisation (from containerConfig)
  model?: string;
  systemPrompt?: string;
  script?: string;
  endpoint?: string;
  transform?: string;
  sdkMode?: string;
  awsRegion?: string;
  webSearchVendor?: string;
  contextWindowSize?: number;
  learningLoop?: boolean | 'extract-only';
  approvalTimeout?: number;
  commandAllowlist?: string[];
  nudgeInterval?: number;
  mcpServers?: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
  // Multimodal: base64-encoded images for vision-capable models
  images?: Array<{ base64: string; mediaType: string; caption?: string }>;
  // Per-turn reminder injected via UserPromptSubmit hook (live chat only)
  promptReminder?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | Array<{ type: string; [key: string]: any }> };
  parent_tool_use_id: null;
  session_id?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_POLL_MS = 500;

// Module-level token tracking — updated by runQuery(), read by main()
let lastInputTokens = 0;

// Module-level turn counter for periodic memory nudge
// Tracks completed results (not outer-loop iterations) since messages
// are piped into the running query and the outer loop rarely iterates.
let turnsSinceLastNudge = 0;

// Module-level flag to prevent repeated threshold nudges in a single session
let thresholdNudgedThisSession = false;

// Verified tool catalog fallback (SDK 0.3.147).
// Used only when NANOCLAW_TOOL_ALLOWLIST env var is absent or invalid.
// Update this list when upgrading the Claude Agent SDK.
// Source of truth: repo/tool-allowlist.json (maintained via sdk-upgrade rediscovery procedure).
const FALLBACK_CATALOG = [
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'Read',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TeamCreate',
  'TeamDelete',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.waiting?.();
  }

  /** Push a multimodal message with content blocks (image + text). */
  pushMultimodal(content: Array<{ type: string; [key: string]: any }>): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Inject per-turn reminder text as additionalContext on every user prompt.
 */
function createReminderHook(reminder: string): HookCallback {
  return async () => ({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
    },
  });
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Write a status message to the IPC messages directory.
 * Uses atomic write (tmp + rename) to prevent partial reads.
 */
function sendStatusMessage(text: string, chatJid: string, groupFolder: string): void {
  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(IPC_MESSAGES_DIR, filename);
  const data = { type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString() };
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
function drainIpcInput(): Array<{ text: string; images?: Array<{ base64: string; mediaType: string; caption?: string }> }> {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: Array<{ text: string; images?: Array<{ base64: string; mediaType: string; caption?: string }> }> = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          const entry: { text: string; images?: Array<{ base64: string; mediaType: string; caption?: string }> } = { text: data.text };
          if (Array.isArray(data.images) && data.images.length > 0) {
            entry.images = data.images;
          }
          messages.push(entry);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<{ type: 'message'; text: string; images?: Array<{ base64: string; mediaType: string; caption?: string }> } | { type: 'close' }> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve({ type: 'close' });
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // Combine text from all messages; collect all images
        const text = messages.map(m => m.text).join('\n');
        const allImages: Array<{ base64: string; mediaType: string; caption?: string }> = [];
        for (const m of messages) {
          if (m.images) allImages.push(...m.images);
        }
        resolve({ type: 'message', text, images: allImages.length > 0 ? allImages : undefined });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  options?: { acceptIpc?: boolean; nudgeInterval?: number; contextWindowSize?: number; images?: Array<{ base64: string; mediaType: string; caption?: string }> },
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; resultCount: number }> {
  const acceptIpc = options?.acceptIpc !== false; // default true
  const stream = new MessageStream();
  const controller = new AbortController();

  // Build initial message: multimodal (images + text) or plain text
  const images = options?.images;
  if (images && images.length > 0) {
    const contentBlocks: Array<{ type: string; [key: string]: any }> = [];
    for (const img of images) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
    contentBlocks.push({ type: 'text', text: prompt });
    stream.pushMultimodal(contentBlocks);
    log(`Pushed multimodal prompt with ${images.length} image(s)`);
  } else {
    stream.push(prompt);
  }

  // Flush queries are single-turn — end the stream immediately so the
  // SDK's for-await loop exits after the agent responds.
  if (!acceptIpc) {
    stream.end();
  }  // Poll IPC for follow-up messages and _close sentinels during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      controller.abort();
      ipcPolling = false;
      return;
    }
    if (acceptIpc) {
      const messages = drainIpcInput();
      for (const msg of messages) {
        if (msg.images && msg.images.length > 0) {
          // Build multimodal content blocks: images + text
          const contentBlocks: Array<{ type: string; [key: string]: any }> = [];
          for (const img of msg.images) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.base64,
              },
            });
          }
          contentBlocks.push({ type: 'text', text: msg.text });
          log(`Piping multimodal IPC message into active query (${msg.text.length} chars, ${msg.images.length} image(s))`);
          stream.pushMultimodal(contentBlocks);
        } else {
          log(`Piping IPC message into active query (${msg.text.length} chars)`);
          stream.push(msg.text);
        }
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // --- Allowlist-ceiling tool resolution ---
  // The container is the authoritative gate. Resolution model:
  //   ceiling   = NANOCLAW_TOOL_ALLOWLIST env (JSON array) ?? FALLBACK_CATALOG
  //   resolved  = ceiling − deniedTools − Bash(if approvalMode) − WebSearch/WebFetch(if !nativeWebTools)
  //   options.tools = resolved (the real gate — constrains preset-injected CLI tools too)
  //   options.allowedTools = [...resolved, 'mcp__nanoclaw__*'] (auto-approve under bypassPermissions)
  // mcp__nanoclaw__* is always included so IPC works regardless of config.

  const approvalMode = process.env.NANOCLAW_APPROVAL_MODE === 'true';
  const nativeWebTools = process.env.NANOCLAW_NATIVE_WEB_TOOLS === 'true';

  // Parse ceiling from host-injected env var
  let ceiling: string[];
  try {
    const raw = process.env.NANOCLAW_TOOL_ALLOWLIST;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((t: unknown) => typeof t === 'string')) {
        ceiling = parsed;
      } else {
        log('NANOCLAW_TOOL_ALLOWLIST invalid — using FALLBACK_CATALOG');
        ceiling = FALLBACK_CATALOG;
      }
    } else {
      log('NANOCLAW_TOOL_ALLOWLIST absent — using FALLBACK_CATALOG');
      ceiling = FALLBACK_CATALOG;
    }
  } catch {
    log('NANOCLAW_TOOL_ALLOWLIST parse error — using FALLBACK_CATALOG');
    ceiling = FALLBACK_CATALOG;
  }

  // Parse per-group denied tools
  let deniedTools: string[] = [];
  try {
    const raw = process.env.NANOCLAW_DENIED_TOOLS;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        deniedTools = parsed.filter((t: unknown) => typeof t === 'string');
      }
    }
  } catch {
    log('NANOCLAW_DENIED_TOOLS parse error — ignoring');
  }

  // Build denied set (hard rules + per-group)
  const denySet = new Set<string>(deniedTools);
  if (approvalMode) denySet.add('Bash');
  if (!nativeWebTools) {
    denySet.add('WebSearch');
    denySet.add('WebFetch');
  }

  // Resolve: ceiling minus all denies
  const resolved = ceiling.filter(t => !denySet.has(t));

  // options.tools = resolved (the authoritative gate)
  // options.allowedTools = resolved + IPC wildcard (auto-approve)
  const tools = resolved;
  const allowedTools = [...resolved, 'mcp__nanoclaw__*'];

  // Apply model override if configured
  if (containerInput.model) {
    sdkEnv.ANTHROPIC_MODEL = containerInput.model;
  }
  log(`Using model: ${sdkEnv.ANTHROPIC_MODEL || 'default'}`);

  // Build system prompt: per-group systemPrompt from config
  let appendPrompt = '';
  if (containerInput.systemPrompt) {
    appendPrompt = containerInput.systemPrompt;
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  try {
    for await (const message of query({
      prompt: stream as any,
      options: {
        abortController: controller,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: appendPrompt
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: appendPrompt }
          : undefined,
        allowedTools: allowedTools,
        tools: tools,
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              NANOCLAW_IS_ADMIN: containerInput.isAdmin ? '1' : '0',
            },
          },
          // Merge per-group MCP servers from containerConfig.
          // nanoclaw is always present and cannot be overridden.
          ...(containerInput.mcpServers || {}),
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          ...(containerInput.promptReminder
            ? { UserPromptSubmit: [{ hooks: [createReminderHook(containerInput.promptReminder)] }] }
            : {}),
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      // Token usage logging — deduplicate by message ID (SDK emits thinking + text
      // as separate assistant events with the same msg_ ID). Last write wins so we
      // capture the final emission which has accurate output_tokens.
      if (message.type === 'assistant' && 'message' in message) {
        const msg = (message as any).message;
        const msgId = msg?.id;
        const usage = msg?.usage;
        const contentTypes = Array.isArray(msg?.content) ? msg.content.map((c: any) => c.type).join(',') : 'unknown';
        log(`Token tracking: id=${msgId} content=[${contentTypes}] input=${usage?.input_tokens ?? '?'} output=${usage?.output_tokens ?? '?'}`);
        if (msgId && usage) {
          // Update module-level tracker — last write wins (final emission per msg_ ID is accurate)
          if (usage.input_tokens) {
            lastInputTokens = usage.input_tokens;
          }
          const entry = `[${new Date().toISOString()}] id=${msgId} type=${contentTypes} input=${usage.input_tokens ?? '?'} output=${usage.output_tokens ?? '?'}`;
          const logPath = '/workspace/group/token-usage.log';
          try {
            const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
            // Replace previous entry for same msg ID, or prepend if new
            const lines = existing.split('\n').filter(l => l.trim());
            const filtered = lines.filter(l => !l.includes(`id=${msgId}`));
            filtered.unshift(entry);
            fs.writeFileSync(logPath, filtered.join('\n') + '\n');
          } catch (e) {
            log(`Token log write failed: ${(e as Error).message}`);
          }
        } else if (!msgId) {
          log('Assistant message has no message ID');
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });

        // --- Periodic memory nudge (inside query loop) ---
        // Count completed results as "turns" since messages are piped into
        // the running query and the outer loop rarely iterates.
        const nudgeInterval = options?.nudgeInterval || 0;
        if (nudgeInterval > 0 && !containerInput.isScheduledTask) {
          turnsSinceLastNudge++;
          if (turnsSinceLastNudge >= nudgeInterval) {
            log(`Periodic nudge triggered (turns since last: ${turnsSinceLastNudge})`);
            turnsSinceLastNudge = 0;
            const nudgePrompt = buildNudgePrompt({ reason: 'periodic' });
            stream.push(nudgePrompt);
            log('Periodic memory nudge injected into stream');
          }
        }

        // --- Memory threshold nudge check (inside query loop) ---
        const ctxSize = options?.contextWindowSize || 0;
        if (ctxSize > 0 && !thresholdNudgedThisSession && lastInputTokens > ctxSize * 0.8) {
          log(`Token threshold crossed (${lastInputTokens}/${ctxSize}), injecting threshold memory nudge`);
          thresholdNudgedThisSession = true;
          const nudgePrompt = buildNudgePrompt({ reason: 'threshold' });
          stream.push(nudgePrompt);
          log('Threshold memory nudge injected into stream');
        }
      }
    }
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
      log('Query aborted via AbortController (closedDuringQuery)');
      closedDuringQuery = true;
    } else {
      throw err;
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, resultCount };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Resolve context window size (DB config → default 128000)
  const contextWindowSize = containerInput.contextWindowSize || 128000;
  log(`Context window size: ${contextWindowSize}`);

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  // SDK 0.3.142+: MCP servers connect in background by default. Restore blocking
  // behaviour so the nanoclaw IPC server is ready on turn 1.
  sdkEnv.MCP_CONNECTION_NONBLOCKING = '0';

  // Forward the group's endpoint name to the credential proxy via default headers.
  // The proxy uses X-Nanoclaw-Endpoint to route to the correct upstream.
  const endpoint = containerInput.endpoint || process.env.NANOCLAW_ENDPOINT || 'anthropic';
  const webSearchVendor = containerInput.webSearchVendor || process.env.NANOCLAW_WEB_SEARCH_VENDOR || 'ollama';
  const transform = containerInput.transform || process.env.NANOCLAW_TRANSFORM;
  const sdkMode = containerInput.sdkMode || process.env.NANOCLAW_SDK_MODE;

  // Custom headers — always include endpoint + web-search-vendor for proxy routing.
  const headerLines = [
    `X-Nanoclaw-Endpoint: ${endpoint}`,
    `X-Nanoclaw-Web-Search-Vendor: ${webSearchVendor}`,
  ];
  if (transform) {
    headerLines.push(`X-Nanoclaw-Transform: ${transform}`);
  }

  if (sdkMode === 'bedrock') {
    // --- Bedrock SDK mode ---
    // The Claude Code SDK talks Bedrock Invoke API shape + binary eventstream.
    // The proxy URL is used as ANTHROPIC_BEDROCK_BASE_URL; the SDK uses Bearer auth
    // with a placeholder token (proxy strips it + injects real auth).
    // Custom headers still ride along for routing (X-Nanoclaw-Endpoint).
    const proxyBase = process.env.ANTHROPIC_BASE_URL || `http://host.docker.internal:3001`;
    const awsRegion = containerInput.awsRegion || process.env.AWS_REGION || 'us-east-1';

    sdkEnv.CLAUDE_CODE_USE_BEDROCK = '1';
    sdkEnv.AWS_REGION = awsRegion;
    sdkEnv.ANTHROPIC_BEDROCK_BASE_URL = proxyBase;
    sdkEnv.AWS_BEARER_TOKEN_BEDROCK = 'placeholder';
    sdkEnv.ANTHROPIC_CUSTOM_HEADERS = headerLines.join('\n');

    // Remove anthropic-track env to avoid SDK confusion
    delete sdkEnv.ANTHROPIC_API_KEY;
    delete sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;

    log(`Bedrock SDK mode: region=${awsRegion} base=${proxyBase} endpoint=${endpoint}`);
  } else {
    // --- Anthropic SDK mode (default, unchanged) ---
    sdkEnv.ANTHROPIC_CUSTOM_HEADERS = headerLines.join('\n');
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  // Images from initial input + any pending IPC messages; cleared after first query
  let pendingImages = containerInput.images;

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map(m => m.text).join('\n');
    // Collect any images from pending IPC messages into the initial images array
    for (const m of pending) {
      if (m.images) {
        if (!pendingImages) pendingImages = [];
        pendingImages.push(...m.images);
      }
    }
  }

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, {
        nudgeInterval: containerInput.isScheduledTask ? 0 : (containerInput.nudgeInterval ?? 10),
        contextWindowSize,
        images: pendingImages,
      });
      // Clear images after each query — next iteration gets fresh images from waitForIpcMessage
      pendingImages = undefined;
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Post-turn health checks (silent turn detection, degenerate content cleanup)
      runPostTurnChecks({
        sessionId,
        resultCount: queryResult.resultCount,
        closedDuringQuery: queryResult.closedDuringQuery,
        chatJid: containerInput.chatJid,
        groupFolder: containerInput.groupFolder,
        isScheduledTask: containerInput.isScheduledTask,
      });

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextEvent = await waitForIpcMessage();
      if (nextEvent.type === 'close') {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextEvent.text.length} chars), starting new query`);
      prompt = nextEvent.text;
      pendingImages = nextEvent.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
