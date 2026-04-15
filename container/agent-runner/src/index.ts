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
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

import { buildFlushPrompt } from './lib/flush-prompt.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  // Agent customisation (from containerConfig)
  allowedTools?: string[];
  model?: string;
  systemPrompt?: string;
  script?: string;
  endpoint?: string;
  webSearchVendor?: string;
  contextWindowSize?: number;
  learningLoop?: boolean | 'extract-only';
  approvalTimeout?: number;
  commandAllowlist?: string[];
  mcpServers?: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  flushCompleted?: boolean;
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
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_FLUSH_SENTINEL = path.join(IPC_INPUT_DIR, '_flush');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_POLL_MS = 500;

// Module-level token tracking — updated by runQuery(), read by main()
let lastInputTokens = 0;

// Module-level ref to containerInput so getFlushPrompt() can read learningLoop
let containerInputRef: ContainerInput | undefined;

function getFlushPrompt(): string {
  return buildFlushPrompt({ reason: 'context-window', learningLoop: containerInputRef?.learningLoop });
}

// All known tools (SDK + claude_code preset built-ins).
// Update this list when upgrading the Claude Agent SDK.
// Source of truth: agentic-tools/nanoclaw/README.md tool reference table.
const ALL_KNOWN_TOOLS = [
  // File operations
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  // Execution
  'Bash', 'NotebookEdit',
  // Web
  'WebSearch', 'WebFetch',
  // Planning
  'EnterPlanMode', 'ExitPlanMode',
  // Tasks
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput',
  // Scheduling
  'CronCreate', 'CronDelete', 'CronList',
  // Git/Worktree
  'EnterWorktree', 'ExitWorktree',
  // Agent teams
  'TeamCreate', 'TeamDelete', 'SendMessage',
  // Agent & Skills
  'Agent', 'Skill', 'RemoteTrigger',
  // User interaction
  'AskUserQuestion',
  // Misc
  'TodoWrite', 'ToolSearch',
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
      session_id: '',
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
 * Check for _flush sentinel.
 */
function shouldFlush(): boolean {
  if (fs.existsSync(IPC_INPUT_FLUSH_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }
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
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
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
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<{ type: 'message'; text: string } | { type: 'close' } | { type: 'flush' }> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve({ type: 'close' });
        return;
      }
      if (shouldFlush()) {
        resolve({ type: 'flush' });
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve({ type: 'message', text: messages.join('\n') });
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
  options?: { acceptIpc?: boolean },
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; flushRequestedDuringQuery: boolean }> {
  const acceptIpc = options?.acceptIpc !== false; // default true
  const stream = new MessageStream();
  stream.push(prompt);

  // Flush queries are single-turn — end the stream immediately so the
  // SDK's for-await loop exits after the agent responds.
  if (!acceptIpc) {
    stream.end();
  }  // Poll IPC for follow-up messages and _close/_flush sentinels during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let flushRequestedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (acceptIpc && shouldFlush()) {
      log('Flush sentinel detected during query, ending stream');
      flushRequestedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (acceptIpc) {
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Use per-group tools if configured, otherwise all known tools.
  // mcp__nanoclaw__* is always included so IPC works regardless of config.
  const tools = containerInput.allowedTools
    ? [...containerInput.allowedTools, 'mcp__nanoclaw__*']
    : [...ALL_KNOWN_TOOLS, 'mcp__nanoclaw__*'];

  // Compute disallowedTools as the complement of allowedTools.
  // The SDK's allowedTools only filters SDK-registered tools; preset-injected CLI tools
  // (Agent, CronCreate, EnterPlanMode, etc.) bypass it. disallowedTools blocks everything.
  // mcp__nanoclaw__* is never disallowed — IPC must always work.
  const disallowedTools = containerInput.allowedTools
    ? ALL_KNOWN_TOOLS.filter(t => !tools.includes(t))
    : [];

  // Apply model override if configured
  if (containerInput.model) {
    sdkEnv.ANTHROPIC_MODEL = containerInput.model;
  }
  log(`Using model: ${sdkEnv.ANTHROPIC_MODEL || 'default'}`);

  // Build system prompt: global CLAUDE.md + per-group systemPrompt from config
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let appendPrompt = '';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    appendPrompt += fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  if (containerInput.systemPrompt) {
    appendPrompt += (appendPrompt ? '\n\n' : '') + containerInput.systemPrompt;
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

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: appendPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: appendPrompt }
        : undefined,
      allowedTools: tools,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
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
          },
        },
        // Merge per-group MCP servers from containerConfig.
        // nanoclaw is always present and cannot be overridden.
        ...(containerInput.mcpServers || {}),
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
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
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, flushRequestedDuringQuery: ${flushRequestedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, flushRequestedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    containerInputRef = containerInput;
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

  // Forward the group's endpoint name to the credential proxy via default headers.
  // The proxy uses X-Nanoclaw-Endpoint to route to the correct upstream.
  const endpoint = containerInput.endpoint || process.env.NANOCLAW_ENDPOINT || 'anthropic';
  const webSearchVendor = containerInput.webSearchVendor || process.env.NANOCLAW_WEB_SEARCH_VENDOR || 'ollama';
  sdkEnv.ANTHROPIC_CUSTOM_HEADERS = [
    `X-Nanoclaw-Endpoint: ${endpoint}`,
    `X-Nanoclaw-Web-Search-Vendor: ${webSearchVendor}`,
  ].join('\n');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  // Clean up stale _flush sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_FLUSH_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let flushedThisSession = false;

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
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

      // --- Flush requested during query (agent called manual_flush) ---
      if (!flushedThisSession && queryResult.flushRequestedDuringQuery) {
        log('Flush sentinel consumed during query, running flush prompt');
        sendStatusMessage('Creating long term memories...', containerInput.chatJid, containerInput.groupFolder);
        const flushResult = await runQuery(getFlushPrompt(), sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, { acceptIpc: false });
        flushedThisSession = true;
        if (flushResult.newSessionId) sessionId = flushResult.newSessionId;
        if (flushResult.lastAssistantUuid) resumeAt = flushResult.lastAssistantUuid;
        sendStatusMessage('Ready for next message', containerInput.chatJid, containerInput.groupFolder);
        log('Flush (during-query) complete, signalling host');
        writeOutput({ status: 'success', result: null, newSessionId: sessionId, flushCompleted: true });
      }

      // --- Memory flush threshold check ---
      if (!flushedThisSession && lastInputTokens > contextWindowSize * 0.8) {
        log(`Token threshold crossed (${lastInputTokens}/${contextWindowSize}), injecting memory flush`);

        sendStatusMessage('Creating long term memories...', containerInput.chatJid, containerInput.groupFolder);
        const flushResult = await runQuery(getFlushPrompt(), sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, { acceptIpc: false });
        flushedThisSession = true;

        if (flushResult.newSessionId) {
          sessionId = flushResult.newSessionId;
        }
        if (flushResult.lastAssistantUuid) {
          resumeAt = flushResult.lastAssistantUuid;
        }

        sendStatusMessage('Ready for next message', containerInput.chatJid, containerInput.groupFolder);
        log('Memory flush complete, signalling host');
        writeOutput({ status: 'success', result: null, newSessionId: sessionId, flushCompleted: true });
      }

      // --- Manual flush sentinel check ---
      if (!flushedThisSession && shouldFlush()) {
        log('Manual flush requested via MCP tool');

        sendStatusMessage('Creating long term memories...', containerInput.chatJid, containerInput.groupFolder);
        const flushResult = await runQuery(getFlushPrompt(), sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, { acceptIpc: false });
        flushedThisSession = true;

        if (flushResult.newSessionId) {
          sessionId = flushResult.newSessionId;
        }
        if (flushResult.lastAssistantUuid) {
          resumeAt = flushResult.lastAssistantUuid;
        }

        sendStatusMessage('Ready for next message', containerInput.chatJid, containerInput.groupFolder);
        log('Manual flush complete, signalling host');
        writeOutput({ status: 'success', result: null, newSessionId: sessionId, flushCompleted: true });
      }

      // Emit session update so host can track it (skip if we just flushed —
      // the flush marker already carried newSessionId, and re-emitting would
      // undo the host's session cleanup)
      if (!flushedThisSession) {
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message, _close sentinel, or _flush sentinel
      const nextEvent = await waitForIpcMessage();
      if (nextEvent.type === 'close') {
        log('Close sentinel received, exiting');
        break;
      }

      if (nextEvent.type === 'flush') {
        if (!flushedThisSession) {
          log('Flush sentinel received while idle, running flush');
          sendStatusMessage('Creating long term memories...', containerInput.chatJid, containerInput.groupFolder);
          const flushResult = await runQuery(getFlushPrompt(), sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, { acceptIpc: false });
          flushedThisSession = true;
          if (flushResult.newSessionId) sessionId = flushResult.newSessionId;
          if (flushResult.lastAssistantUuid) resumeAt = flushResult.lastAssistantUuid;
          sendStatusMessage('Ready for next message', containerInput.chatJid, containerInput.groupFolder);
          log('Idle flush complete, signalling host');
          writeOutput({ status: 'success', result: null, newSessionId: sessionId, flushCompleted: true });
        } else {
          log('Flush sentinel received but already flushed this session, ignoring');
        }
        continue;
      }

      log(`Got new message (${nextEvent.text.length} chars), starting new query`);
      prompt = nextEvent.text;
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
