export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

export interface SsrfConfig {
  allowPrivateNetworks?: boolean;
  additionalBlockedHosts?: string[];
  additionalAllowedHosts?: string[];
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)

  // --- Mount-level isolation ---

  /**
   * Per-group skill selection.
   * undefined = all skills (backward compat), [] = no skills, ["x","y"] = only x and y.
   */
  skills?: string[];

  // --- SDK-level agent customisation ---

  /**
   * Per-group tool restrictions.
   * undefined = use default allowedTools list (backward compat).
   * Accepts same tool names as the Claude Agent SDK: Bash, Read, Write, Edit, etc.
   */
  allowedTools?: string[];

  /**
   * Per-group model override.
   * undefined = inherit from host env (backward compat).
   * Accepts model IDs or aliases: "sonnet", "opus", "haiku", "glm-5:cloud", etc.
   */
  model?: string;

  /**
   * Per-group system prompt (appended to the claude_code preset).
   * undefined = use global/CLAUDE.md only (backward compat).
   * This is the agent's "soul" — persona, instructions, constraints.
   */
  systemPrompt?: string;

  /**
   * Per-group MCP servers to spawn alongside the built-in nanoclaw server.
   * Key is the server name (e.g. "brave-search"), value is the spawn config.
   * API keys for MCP servers are injected by container-runner as env vars.
   */
  mcpServers?: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };

  /**
   * Named endpoint to use for this group's API traffic.
   * Must match a vendor prefix defined in secrets.env (e.g. "anthropic", "ollama", "zai").
   * The credential proxy routes requests to the correct upstream based on this value.
   * Required — no default. Set during group registration via --endpoint.
   */
  endpoint?: string;

  /**
   * Context window size for this group's model (in tokens).
   * Used to calculate flush thresholds (80% live, 50% nightly).
   * Defaults to 128000 if omitted.
   */
  contextWindowSize?: number;

  /**
   * Named web search vendor for this group's web search traffic.
   * Must match a vendor prefix defined in secrets.env
   * (e.g. "ollama" for OLLAMA_WEB_SEARCH_BASE_URL / OLLAMA_WEB_SEARCH_API_KEY).
   * The credential proxy routes web search requests to the correct upstream.
   * Defaults to "ollama" if omitted.
   */
  webSearchVendor?: string;

  /**
   * Name of the Telegram bot instance to use for this group's outbound replies.
   * Maps to `TELEGRAM_{NAME}_BOT_TOKEN` in secrets.env (case-insensitive).
   * If omitted, the group uses the default `TELEGRAM_BOT_TOKEN`.
   */
  telegramBot?: string;

  /**
   * Prompt injection scanning mode for context files.
   * Scans CLAUDE.md, MEMORY.md, COMPACT.md, and daily notes before container launch.
   * - undefined / absent → 'warn' (secure default — log but don't block)
   * - 'off' → skip scanning entirely
   * - 'warn' → log findings, continue with container launch
   * - 'block' → abort container launch on critical findings, notify user
   */
  injectionScanMode?: 'off' | 'warn' | 'block';

  /**
   * SSRF protection for outbound web_fetch requests.
   * - undefined / absent → enabled (secure by default)
   * - false → disabled (for groups that intentionally need internal network access)
   * - true → enabled with default settings
   * - SsrfConfig object → enabled with custom host lists
   */
  ssrfProtection?: boolean | SsrfConfig;

  /**
   * Command approval mode for dangerous commands on write-mounted paths.
   * When enabled, Bash is replaced with mcp__nanoclaw__execute_command which
   * pauses on dangerous commands and requests user approval via messaging channel.
   * - undefined / absent → false (backward compatible — Bash available as normal)
   * - false → Bash available, no approval checks
   * - true → Bash replaced with execute_command, dangerous commands require approval
   */
  approvalMode?: boolean;

  /**
   * Timeout in seconds for command approval requests.
   * When a dangerous command is detected and approval is requested,
   * the request auto-denies after this many seconds.
   * - undefined / absent → 120 (2 minutes)
   * - Valid range: 10–600
   */
  approvalTimeout?: number;

  /**
   * Permanently approved command patterns (regex strings).
   * Commands matching any pattern in this list skip the approval flow
   * even when approvalMode is enabled. Use sparingly.
   * - undefined / absent → [] (no pre-approved patterns)
   */
  commandAllowlist?: string[];

  /**
   * Per-group host command allowlist.
   * undefined = no host commands allowed (secure default).
   * [] = explicitly none.
   * ['model'] = allows /model host command.
   */
  allowedHostCommands?: string[];

  /**
   * Self-improving learning loop — skill extraction during memory flush.
   * When enabled, the flush prompt includes a skill extraction step before
   * memory/compact/daily-note steps.
   * - undefined / absent → false (no skill extraction)
   * - false → no skill extraction
   * - true → extract skills during flush AND load them into the next session
   * - 'extract-only' → extract skills during flush but do NOT load into next session (review before enabling full loop)
   */
  learningLoop?: boolean | 'extract-only';
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  multiAgentRouter?: boolean; // When true (main groups only): scan incoming messages for other groups' triggers and auto-delegate
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  script?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
