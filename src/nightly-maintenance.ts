import fs from 'fs';
import path from 'path';

import {
  DEFAULT_CONTEXT_WINDOW,
  GROUPS_DIR,
  LOGS_DIR,
  NIGHTLY_NUDGE_THRESHOLD,
} from './config.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  expireStaleDelegations,
  pruneOldMessages,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { getNightlyNudgePrompt } from './lib/nudge-prompt.js';
import { logger } from './logger.js';
import { resolvePreset } from './presets.js';
import { RegisteredGroup } from './types.js';

/**
 * Parse the last input_tokens value from a group's token-usage.log.
 * Returns 0 if the file doesn't exist or can't be parsed.
 */
export function parseLastInputTokens(groupFolder: string): number {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(groupFolder);
  } catch {
    return 0;
  }
  const logPath = path.join(groupDir, 'token-usage.log');
  if (!fs.existsSync(logPath)) return 0;

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return 0;

    // Log is prepended (newest first), so first line is the latest entry.
    // Format: [ISO] id=msg_xxx type=... input=NNN output=NNN
    const match = lines[0].match(/input=(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

// --- Log cleanup utilities ---

const RETENTION_DAYS = 30;
const TOKEN_USAGE_MAX_LINES = 100;

/**
 * Daily copytruncate rotation for the main app logs.
 * Copies current log to a dated file, then truncates the original to 0 bytes.
 * Also prunes rotated files older than 30 days.
 */
export function rotateMainLogs(logsDir: string): {
  rotated: string[];
  pruned: string[];
} {
  const result = { rotated: [] as string[], pruned: [] as string[] };

  if (!fs.existsSync(logsDir)) return result;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const targets = ['nanoclaw.log', 'nanoclaw.error.log'];

  for (const target of targets) {
    const srcPath = path.join(logsDir, target);
    if (!fs.existsSync(srcPath)) continue;

    const stats = fs.statSync(srcPath);
    if (stats.size === 0) continue;

    // Determine the rotated filename: nanoclaw-YYYY-MM-DD.log / nanoclaw.error-YYYY-MM-DD.log
    const ext = '.log';
    const base = target.slice(0, -ext.length); // "nanoclaw" or "nanoclaw.error"
    const rotatedName = `${base}-${today}${ext}`;
    const rotatedPath = path.join(logsDir, rotatedName);

    // Skip if already rotated today (idempotent)
    if (fs.existsSync(rotatedPath)) continue;

    // Copytruncate: copy then truncate original
    fs.copyFileSync(srcPath, rotatedPath);
    fs.truncateSync(srcPath, 0);
    result.rotated.push(rotatedName);
  }

  // Prune old rotated files (nanoclaw-YYYY-MM-DD.log or nanoclaw.error-YYYY-MM-DD.log)
  const rotatedPattern = /^nanoclaw(?:\.error)?-(\d{4}-\d{2}-\d{2})\.log$/;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const match = entry.match(rotatedPattern);
    if (!match) continue;

    const fileDate = new Date(match[1] + 'T00:00:00Z');
    if (isNaN(fileDate.getTime())) continue;

    if (fileDate < cutoff) {
      try {
        fs.unlinkSync(path.join(logsDir, entry));
        result.pruned.push(entry);
      } catch (err) {
        logger.warn({ file: entry, err }, 'Failed to prune rotated log');
      }
    }
  }

  return result;
}

/**
 * Delete per-group container logs older than 30 days.
 * Parses the ISO timestamp from the filename to determine age.
 */
export function pruneContainerLogs(
  groups: Record<string, RegisteredGroup>,
): number {
  let pruned = 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Filename format: container-YYYY-MM-DDTHH-MM-SS-mmmZ.log
  // The timestamp uses hyphens instead of colons/dots.
  const filenamePattern =
    /^container-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log$/;

  for (const group of Object.values(groups)) {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch {
      continue;
    }

    const logsDir = path.join(groupDir, 'logs');
    if (!fs.existsSync(logsDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(logsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const match = entry.match(filenamePattern);
      if (!match) continue;

      // Reconstruct ISO string: 2026-04-04T11:58:21.967Z
      const isoStr = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
      const fileTime = new Date(isoStr).getTime();
      if (isNaN(fileTime)) continue;

      if (fileTime < cutoff) {
        try {
          fs.unlinkSync(path.join(logsDir, entry));
          pruned++;
        } catch (err) {
          logger.warn(
            { group: group.folder, file: entry, err },
            'Failed to prune container log',
          );
        }
      }
    }
  }

  return pruned;
}

/**
 * Truncate per-group token-usage.log to the most recent 100 lines.
 * The file is prepended (newest first), so we keep the first 100 lines.
 */
export function truncateTokenUsageLogs(
  groups: Record<string, RegisteredGroup>,
): number {
  let trimmed = 0;

  for (const group of Object.values(groups)) {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch {
      continue;
    }

    const logPath = path.join(groupDir, 'token-usage.log');
    if (!fs.existsSync(logPath)) continue;

    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');

      // Find the byte offset after the first 100 non-empty lines.
      // We count all lines (including empty trailing) but only care about
      // keeping the first TOKEN_USAGE_MAX_LINES content lines.
      let contentLineCount = 0;
      let byteOffset = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          contentLineCount++;
        }
        if (contentLineCount > TOKEN_USAGE_MAX_LINES) {
          // Truncate at this point
          fs.truncateSync(logPath, byteOffset);
          trimmed++;
          break;
        }
        // +1 for the newline character (except the last line if no trailing newline)
        byteOffset += Buffer.byteLength(lines[i], 'utf-8');
        if (i < lines.length - 1) {
          byteOffset += 1; // newline
        }
      }
    } catch (err) {
      logger.warn(
        { group: group.folder, err },
        'Failed to truncate token-usage.log',
      );
    }
  }

  return trimmed;
}

export interface NightlyMaintenanceResult {
  groupsChecked: number;
  groupsNudged: string[];
  messagesPruned: number;
  delegationsExpired: number;
  mainLogsRotated: string[];
  mainLogsPruned: string[];
  containerLogsPruned: number;
  tokenLogsTrimmed: number;
}

export interface NightlyDependencies {
  /** Enqueue a nightly nudge prompt for a group via the group queue. */
  runNudge: (group: RegisteredGroup, chatJid: string) => Promise<boolean>;
  /** Override for testing — defaults to getAllRegisteredGroups(). */
  getGroups?: () =>
    | Record<string, RegisteredGroup>
    | Promise<Record<string, RegisteredGroup>>;
  /** Override for testing — defaults to getAllSessions(). */
  getSessions?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Override for testing — defaults to pruneOldMessages(30). */
  pruneMessages?: () => number | Promise<number>;
  /** Override for testing — defaults to expireStaleDelegations(). */
  expireDelegations?: () => number | Promise<number>;
  /** Override for testing — defaults to LOGS_DIR. */
  logsDir?: string;
}

/**
 * Nightly maintenance: check each group with an active session,
 * nudge memory persistence for those above 50% context usage.
 * Does NOT delete sessions — containers stay alive (normal idle timeout applies).
 */
export async function runNightlyMaintenance(
  deps: NightlyDependencies,
): Promise<NightlyMaintenanceResult> {
  const groups = await (deps.getGroups ?? getAllRegisteredGroups)();
  const sessions = await (deps.getSessions ?? getAllSessions)();

  const result: NightlyMaintenanceResult = {
    groupsChecked: 0,
    groupsNudged: [],
    messagesPruned: 0,
    delegationsExpired: 0,
    mainLogsRotated: [],
    mainLogsPruned: [],
    containerLogsPruned: 0,
    tokenLogsTrimmed: 0,
  };

  for (const [jid, group] of Object.entries(groups)) {
    // Only check token usage for groups with active sessions
    if (!sessions[group.folder]) continue;
    result.groupsChecked++;

    const resolved = resolvePreset(group.containerConfig?.preset);
    const contextWindowSize = resolved?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const lastTokens = parseLastInputTokens(group.folder);

    if (lastTokens <= 0) continue;

    const usage = lastTokens / contextWindowSize;
    if (usage < NIGHTLY_NUDGE_THRESHOLD) {
      logger.debug(
        { group: group.folder, usage: `${(usage * 100).toFixed(1)}%` },
        'Group below nightly nudge threshold',
      );
      continue;
    }

    logger.info(
      {
        group: group.folder,
        usage: `${(usage * 100).toFixed(1)}%`,
        lastTokens,
        contextWindowSize,
      },
      'Group above nightly nudge threshold, triggering nudge',
    );

    try {
      const nudged = await deps.runNudge(group, jid);
      if (nudged) {
        result.groupsNudged.push(group.folder);
        logger.info({ group: group.folder }, 'Nightly nudge complete');
      }
    } catch (err) {
      logger.error({ group: group.folder, err }, 'Nightly nudge failed');
    }
  }

  // --- DB maintenance ---
  result.messagesPruned = await (
    deps.pruneMessages ?? (() => pruneOldMessages(30))
  )();
  if (result.messagesPruned > 0) {
    logger.info({ deleted: result.messagesPruned }, 'Pruned old messages');
  }

  result.delegationsExpired = await (
    deps.expireDelegations ?? expireStaleDelegations
  )();
  if (result.delegationsExpired > 0) {
    logger.info(
      { expired: result.delegationsExpired },
      'Expired stale delegations',
    );
  }

  // --- Log cleanup ---
  const logRotation = rotateMainLogs(deps.logsDir ?? LOGS_DIR);
  result.mainLogsRotated = logRotation.rotated;
  result.mainLogsPruned = logRotation.pruned;
  if (logRotation.rotated.length > 0) {
    logger.info({ rotated: logRotation.rotated }, 'Rotated main logs');
  }
  if (logRotation.pruned.length > 0) {
    logger.info({ pruned: logRotation.pruned }, 'Pruned old rotated logs');
  }

  result.containerLogsPruned = pruneContainerLogs(groups);
  if (result.containerLogsPruned > 0) {
    logger.info(
      { pruned: result.containerLogsPruned },
      'Pruned old container logs',
    );
  }

  result.tokenLogsTrimmed = truncateTokenUsageLogs(groups);
  if (result.tokenLogsTrimmed > 0) {
    logger.info(
      { trimmed: result.tokenLogsTrimmed },
      'Trimmed token-usage logs',
    );
  }

  logger.info(
    {
      groupsChecked: result.groupsChecked,
      groupsNudged: result.groupsNudged.length,
    },
    'Nightly maintenance complete',
  );

  return result;
}
