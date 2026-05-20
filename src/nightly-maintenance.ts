import fs from 'fs';
import path from 'path';

import { DEFAULT_CONTEXT_WINDOW, NIGHTLY_NUDGE_THRESHOLD } from './config.js';
import { getAllRegisteredGroups, getAllSessions } from './db.js';
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

export interface NightlyMaintenanceResult {
  groupsChecked: number;
  groupsNudged: string[];
}

export interface NightlyDependencies {
  /** Enqueue a nightly nudge prompt for a group via the group queue. */
  runNudge: (group: RegisteredGroup, chatJid: string) => Promise<boolean>;
  /** Override for testing — defaults to getAllRegisteredGroups(). */
  getGroups?: () => Record<string, RegisteredGroup>;
  /** Override for testing — defaults to getAllSessions(). */
  getSessions?: () => Record<string, string>;
}

/**
 * Nightly maintenance: check each group with an active session,
 * nudge memory persistence for those above 50% context usage.
 * Does NOT delete sessions — containers stay alive (normal idle timeout applies).
 */
export async function runNightlyMaintenance(
  deps: NightlyDependencies,
): Promise<NightlyMaintenanceResult> {
  const groups = (deps.getGroups ?? getAllRegisteredGroups)();
  const sessions = (deps.getSessions ?? getAllSessions)();

  const result: NightlyMaintenanceResult = {
    groupsChecked: 0,
    groupsNudged: [],
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

  logger.info(
    {
      groupsChecked: result.groupsChecked,
      groupsNudged: result.groupsNudged.length,
    },
    'Nightly maintenance complete',
  );

  return result;
}
