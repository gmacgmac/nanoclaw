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
   * Preset name from model-presets.json.
   * Replaces endpoint/model/webSearchVendor/contextWindowSize — those are now
   * resolved at runtime via resolvePreset(). Set during registration or /model switch.
   */
  preset?: string;

  /**
   * Per-group system prompt (appended to the claude_code preset).
   * undefined = use group CLAUDE.md only (backward compat).
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
   * Name of the Telegram bot instance to use for this group's outbound replies.
   * Maps to `TELEGRAM_{NAME}_BOT_TOKEN` in secrets.env (case-insensitive).
   * If omitted, the group uses the default `TELEGRAM_BOT_TOKEN`.
   */
  telegramBot?: string;

  /**
   * Prompt injection scanning mode for context files.
   * Scans CLAUDE.md, MEMORY.md, and daily notes before container launch.
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
   * - undefined / absent → true (secure default — approval active)
   * - false → Bash available, no approval checks (explicit opt-out)
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
   * Self-improving learning loop — skill extraction during memory nudge.
   * When enabled, the nudge prompt includes a skill extraction step.
   * - undefined / absent → false (no skill extraction)
   * - false → no skill extraction
   * - true → extract skills during nudge AND load them into the next session
   * - 'extract-only' → extract skills during nudge but do NOT load into next session (review before enabling full loop)
   */
  learningLoop?: boolean | 'extract-only';

  /**
   * Per-group denied tools — subtracted from the system allowlist ceiling
   * (tool-allowlist.json). undefined/absent → [] (deny nothing extra).
   * Hard security rules (Bash under approvalMode, web tools without
   * nativeWebTools) are enforced separately and are NOT overridable here.
   */
  deniedTools?: string[];
}

export type ContainerChannel = 'stable' | 'next';

export const VALID_CONTAINER_CHANNELS: readonly ContainerChannel[] = [
  'stable',
  'next',
] as const;

export function isValidContainerChannel(
  value: string,
): value is ContainerChannel {
  return (VALID_CONTAINER_CHANNELS as readonly string[]).includes(value);
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
  isAdmin?: boolean; // True for the admin group (superset of main — owns register_group)
  containerChannel?: ContainerChannel; // Which image channel this group uses (default: 'stable')
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
  description?: string | null;
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
  status: 'started' | 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Runtime state derivation (BE_01) ---

export type RuntimeState =
  | 'idle'
  | 'due'
  | 'blocked'
  | 'queued'
  | 'running'
  | null;

export interface ScheduledTaskWithRuntime extends ScheduledTask {
  runtime_state: RuntimeState;
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
  // Optional: send a file/image attachment to the user.
  sendAttachment?(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void>;
  /**
   * Optional. Fired after a runtime change to this group's registration.
   * Channels that surface group config on their platform (e.g. Telegram slash
   * commands) should re-sync here. No-op for channels with no platform-visible
   * surface.
   */
  onGroupUpdated?(jid: string): Promise<void>;
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
