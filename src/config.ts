import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'API_PORT',
  'API_TOKEN',
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'CREDENTIAL_PROXY_PORT',
  'DATABASE_URL',
  'DEFAULT_CONTEXT_WINDOW',
  'IDLE_TIMEOUT',
  'MAX_MESSAGES_PER_PROMPT',
  'MAX_CONCURRENT_CONTAINERS',
  'NIGHTLY_NUDGE_THRESHOLD',
  'NUDGE_INTERVAL',
  'SHUTDOWN_GRACE_MS',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Bot';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// PostgreSQL connection URL (loaded from secrets.env or .env)
export const DATABASE_URL =
  process.env.DATABASE_URL || envConfig.DATABASE_URL || '';

// REST API server (see src/api/). Disabled if API_PORT is 0.
export const API_PORT = parseInt(
  process.env.API_PORT || envConfig.API_PORT || '3100',
  10,
);
export const API_TOKEN = process.env.API_TOKEN || envConfig.API_TOKEN || '';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
export const HOME_DIR = process.env.HOME || os.homedir();
export const TEMPLATES_DIR = path.resolve(
  PROJECT_ROOT,
  'docs',
  'prompt-behaviours',
);

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const LOGS_DIR = path.resolve(PROJECT_ROOT, 'logs');
// Allow external tools (e.g., dashboard) to discover data directory
export const DATA_DIR = process.env.NANOCLAW_DATA_DIR
  ? path.resolve(process.env.NANOCLAW_DATA_DIR)
  : path.resolve(PROJECT_ROOT, 'data');

// Base image name (without tag). Channel routing resolves the tag per-group.
// CONTAINER_IMAGE env var is still respected as a full override (e.g., for local dev).
export const CONTAINER_IMAGE_OVERRIDE =
  process.env.CONTAINER_IMAGE || envConfig.CONTAINER_IMAGE || '';
export const CONTAINER_IMAGE_BASE = 'nanoclaw-agent';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || envConfig.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    envConfig.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(
    process.env.MAX_MESSAGES_PER_PROMPT ||
      envConfig.MAX_MESSAGES_PER_PROMPT ||
      '10',
    10,
  ) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || envConfig.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_CONTAINERS ||
      envConfig.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

export const NUDGE_INTERVAL = Math.max(
  0,
  parseInt(
    process.env.NUDGE_INTERVAL || envConfig.NUDGE_INTERVAL || '10',
    10,
  ) || 10,
);

// Nightly nudge threshold as a fraction (0.0–1.0). Groups above this % of
// their context window get a memory nudge during nightly maintenance.
export const NIGHTLY_NUDGE_THRESHOLD = Math.min(
  1,
  Math.max(
    0,
    parseFloat(
      process.env.NIGHTLY_NUDGE_THRESHOLD ||
        envConfig.NIGHTLY_NUDGE_THRESHOLD ||
        '0.7',
    ) || 0.7,
  ),
);

// Default context window size (tokens) when a group doesn't specify one.
export const DEFAULT_CONTEXT_WINDOW = parseInt(
  process.env.DEFAULT_CONTEXT_WINDOW ||
    envConfig.DEFAULT_CONTEXT_WINDOW ||
    '128000',
  10,
);

// Graceful shutdown: how long to wait for in-flight containers before hard exit (ms).
export const SHUTDOWN_GRACE_MS = Math.max(
  0,
  parseInt(
    process.env.SHUTDOWN_GRACE_MS || envConfig.SHUTDOWN_GRACE_MS || '30000',
    10,
  ) || 30000,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// --- Tool Allowlist Ceiling ---

// Path to the tracked allowlist file (repo root).
export const TOOL_ALLOWLIST_PATH = path.resolve(
  process.cwd(),
  'tool-allowlist.json',
);

/**
 * Hardcoded fallback: the verified 32-tool catalog from SDK 0.3.147.
 * Used when tool-allowlist.json is missing, unreadable, or invalid.
 */
export const VERIFIED_CATALOG: string[] = [
  'Task',
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
 * Load the tool allowlist ceiling from tool-allowlist.json.
 * Reads fresh on each call (no module-load cache) — supports per-spawn use.
 *
 * Fallback: returns VERIFIED_CATALOG with a warning if the file is missing,
 * unreadable, or contains invalid data. Never fails-open (all tools) or
 * fails-closed (no tools).
 */
export function loadToolAllowlist(): string[] {
  try {
    const raw = fs.readFileSync(TOOL_ALLOWLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn(
        { path: TOOL_ALLOWLIST_PATH },
        'tool-allowlist.json is not an object — using VERIFIED_CATALOG fallback',
      );
      return VERIFIED_CATALOG;
    }

    const obj = parsed as Record<string, unknown>;
    const tools = obj.tools;

    if (!Array.isArray(tools) || tools.length === 0) {
      logger.warn(
        { path: TOOL_ALLOWLIST_PATH },
        'tool-allowlist.json "tools" is missing, not an array, or empty — using VERIFIED_CATALOG fallback',
      );
      return VERIFIED_CATALOG;
    }

    // Validate every entry is a non-empty string
    const valid = tools.every((t) => typeof t === 'string' && t.length > 0);
    if (!valid) {
      logger.warn(
        { path: TOOL_ALLOWLIST_PATH },
        'tool-allowlist.json "tools" contains non-string entries — using VERIFIED_CATALOG fallback',
      );
      return VERIFIED_CATALOG;
    }

    return tools as string[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        { path: TOOL_ALLOWLIST_PATH },
        'tool-allowlist.json not found — using VERIFIED_CATALOG fallback',
      );
    } else {
      logger.warn(
        { err, path: TOOL_ALLOWLIST_PATH },
        'Failed to load tool-allowlist.json — using VERIFIED_CATALOG fallback',
      );
    }
    return VERIFIED_CATALOG;
  }
}
