import fs from 'fs';
import path from 'path';

import { deleteSession, getAllRegisteredGroups, getAllSessions } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { buildFlushPrompt } from './lib/flush-prompt.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const DEFAULT_CONTEXT_WINDOW = 128000;
const FLUSH_THRESHOLD = 0.5;

/** Generate the flush prompt for nightly maintenance. */
export function getNightlyFlushPrompt(
  learningLoop?: boolean | 'extract-only',
): string {
  return buildFlushPrompt({ reason: 'nightly', learningLoop });
}

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

export interface NightlyMaintenanceResult {
  groupsChecked: number;
  groupsFlushed: string[];
}

export interface NightlyDependencies {
  /** Run a flush prompt against a group and return when complete. */
  runFlush: (group: RegisteredGroup, chatJid: string) => Promise<boolean>;
  /** Override for testing — defaults to getAllRegisteredGroups(). */
  getGroups?: () => Record<string, RegisteredGroup>;
  /** Override for testing — defaults to getAllSessions(). */
  getSessions?: () => Record<string, string>;
  /** Override for testing — defaults to deleteSession(). */
  clearSession?: (groupFolder: string) => void;
}

/**
 * Nightly maintenance: check each group with an active session,
 * flush those above 50% context usage.
 */
export async function runNightlyMaintenance(
  deps: NightlyDependencies,
): Promise<NightlyMaintenanceResult> {
  const groups = (deps.getGroups ?? getAllRegisteredGroups)();
  const sessions = (deps.getSessions ?? getAllSessions)();
  const clearSession = deps.clearSession ?? deleteSession;

  const result: NightlyMaintenanceResult = {
    groupsChecked: 0,
    groupsFlushed: [],
  };

  for (const [jid, group] of Object.entries(groups)) {
    // Only check token usage for groups with active sessions
    if (!sessions[group.folder]) continue;
    result.groupsChecked++;

    const contextWindowSize =
      group.containerConfig?.contextWindowSize || DEFAULT_CONTEXT_WINDOW;
    const lastTokens = parseLastInputTokens(group.folder);

    if (lastTokens <= 0) continue;

    const usage = lastTokens / contextWindowSize;
    if (usage < FLUSH_THRESHOLD) {
      logger.debug(
        { group: group.folder, usage: `${(usage * 100).toFixed(1)}%` },
        'Group below nightly flush threshold',
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
      'Group above nightly flush threshold, triggering flush',
    );

    try {
      const flushed = await deps.runFlush(group, jid);
      if (flushed) {
        clearSession(group.folder);
        result.groupsFlushed.push(group.folder);
        logger.info(
          { group: group.folder },
          'Nightly flush + session reset complete',
        );
      }
    } catch (err) {
      logger.error({ group: group.folder, err }, 'Nightly flush failed');
    }
  }

  logger.info(
    {
      groupsChecked: result.groupsChecked,
      groupsFlushed: result.groupsFlushed.length,
    },
    'Nightly maintenance complete',
  );

  return result;
}
