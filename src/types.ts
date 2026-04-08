export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
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

  /**
   * Per-group global subdirectory access.
   * undefined = full global mount read-only (backward compat),
   * {} = no global access,
   * { "*": { readonly: true } } = all of global with specified permission,
   * { "subdir": { readonly: true } } = only named subdirs mounted.
   */
  globalAccess?: {
    [subdirectory: string]: {
      readonly: boolean;
    };
  };

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
   * Defaults to "anthropic" if omitted.
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
