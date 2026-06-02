/**
 * One-time migration: add `deniedTools: []` to all registered groups and
 * remove phantom tool names from `allowedTools`.
 *
 * Behaviour-preserving: the ceiling model (IMPL_04) now governs what's
 * available; Bash/web are handled by hard rules. `deniedTools: []` means
 * "deny nothing extra beyond the hard rules".
 *
 * Phantom tools removed: Agent, RemoteTrigger, TodoWrite — these never
 * resolved to real SDK tools and would only cause confusion.
 *
 * Idempotent: gated by marker file, safe to re-run.
 * Gated by marker file: data/migrations/002-deniedtools-migration.done
 * Backs up DB before any writes.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from '../config.js';
import {
  getAllRegisteredGroups,
  runInTransaction,
  setRegisteredGroup,
} from '../db.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

const MIGRATIONS_DIR = path.join(DATA_DIR, 'migrations');
const MARKER_FILE = path.join(MIGRATIONS_DIR, '002-deniedtools-migration.done');

/** Phantom tool names that never existed in the SDK */
const PHANTOM_TOOLS = new Set(['Agent', 'RemoteTrigger', 'TodoWrite']);

export function runDeniedToolsMigration(): void {
  // 1. Check marker file — already migrated?
  if (fs.existsSync(MARKER_FILE)) {
    return;
  }

  logger.info('Starting deniedTools migration (002-deniedtools-migration)');

  // 2. Backup DB before any writes
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    logger.info('No DB file found — skipping migration (fresh install)');
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    return;
  }

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const backupPath = path.join(
    MIGRATIONS_DIR,
    `nanoclaw-pre-002-deniedtools-migration-${Date.now()}.db.bak`,
  );
  fs.copyFileSync(dbPath, backupPath);
  logger.info({ backupPath }, 'DB backed up before deniedTools migration');

  // 3. Load all registered groups
  const groups = getAllRegisteredGroups();
  const groupEntries = Object.entries(groups);

  if (groupEntries.length === 0) {
    logger.info('No registered groups — migration complete (nothing to do)');
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    return;
  }

  // 4. Process each group
  const updates: Array<{ jid: string; group: RegisteredGroup }> = [];

  for (const [jid, group] of groupEntries) {
    let modified = false;

    // Ensure containerConfig exists
    if (!group.containerConfig) {
      // Group with no config — add minimal deniedTools
      updates.push({
        jid,
        group: { ...group, containerConfig: { deniedTools: [] } },
      });
      logger.info(
        { jid, name: group.name },
        'Added containerConfig with deniedTools: []',
      );
      continue;
    }

    const updatedConfig = { ...group.containerConfig };

    // Add deniedTools: [] if absent
    if (updatedConfig.deniedTools === undefined) {
      updatedConfig.deniedTools = [];
      modified = true;
    }

    // Remove phantom tools from allowedTools
    if (
      updatedConfig.allowedTools &&
      updatedConfig.allowedTools.some((t) => PHANTOM_TOOLS.has(t))
    ) {
      const before = updatedConfig.allowedTools.length;
      updatedConfig.allowedTools = updatedConfig.allowedTools.filter(
        (t) => !PHANTOM_TOOLS.has(t),
      );
      const removed = before - updatedConfig.allowedTools.length;
      logger.info(
        { jid, name: group.name, removed },
        'Removed phantom tools from allowedTools',
      );
      modified = true;
    }

    if (modified) {
      updates.push({
        jid,
        group: { ...group, containerConfig: updatedConfig },
      });
      logger.info(
        { jid, name: group.name },
        'Group updated: deniedTools set, phantoms cleaned',
      );
    } else {
      logger.info(
        { jid, name: group.name },
        'Group already has deniedTools — no changes needed',
      );
    }
  }

  // 5. Save all updated groups inside a transaction (all-or-nothing)
  if (updates.length > 0) {
    runInTransaction(() => {
      for (const { jid, group } of updates) {
        setRegisteredGroup(jid, group);
      }
    });
    logger.info(
      { updatedCount: updates.length, totalGroups: groupEntries.length },
      'deniedTools migration: groups updated',
    );
  } else {
    logger.info('deniedTools migration: all groups already up to date');
  }

  // 6. Write marker file
  fs.writeFileSync(MARKER_FILE, new Date().toISOString());
  logger.info('deniedTools migration complete (002-deniedtools-migration)');
}
