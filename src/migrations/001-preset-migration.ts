/**
 * One-time migration: convert registered groups from containerConfig.{endpoint, model}
 * to containerConfig.preset. Fails loudly if any group cannot be resolved.
 *
 * Gated by marker file: data/migrations/001-preset-migration.done
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
import { findPresetByModelEndpoint, loadPresets } from '../presets.js';
import { RegisteredGroup } from '../types.js';

const MIGRATIONS_DIR = path.join(DATA_DIR, 'migrations');
const MARKER_FILE = path.join(MIGRATIONS_DIR, '001-preset-migration.done');

export function runPresetMigration(): void {
  // 1. Check marker file — already migrated?
  if (fs.existsSync(MARKER_FILE)) {
    return;
  }

  logger.info('Starting preset migration (001-preset-migration)');

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
    `nanoclaw-pre-001-preset-migration-${Date.now()}.db.bak`,
  );
  fs.copyFileSync(dbPath, backupPath);
  logger.info({ backupPath }, 'DB backed up before preset migration');

  // 3. Load all registered groups and presets
  const groups = getAllRegisteredGroups();
  const presets = loadPresets();
  const groupEntries = Object.entries(groups);

  if (groupEntries.length === 0) {
    logger.info('No registered groups — migration complete (nothing to do)');
    fs.writeFileSync(MARKER_FILE, new Date().toISOString());
    return;
  }

  if (Object.keys(presets).length === 0) {
    logger.fatal(
      'FATAL: No presets defined in model-presets.json. Cannot migrate groups. ' +
        'Create presets in ~/.config/nanoclaw/model-presets.json, then restart.',
    );
    logger.info({ backupPath }, 'DB backup available for recovery');
    process.exit(1);
  }

  // 4. Resolve each group
  const errors: Array<{
    jid: string;
    name: string;
    endpoint: string;
    model: string;
  }> = [];
  const updates: Array<{ jid: string; group: RegisteredGroup }> = [];

  for (const [jid, group] of groupEntries) {
    // Already has preset — skip
    if (group.containerConfig?.preset) {
      logger.info(
        { jid, name: group.name, preset: group.containerConfig.preset },
        'Group already has preset — skipping',
      );
      continue;
    }

    // No containerConfig at all — skip with warning (will get error at spawn time)
    if (!group.containerConfig) {
      logger.warn(
        { jid, name: group.name },
        'Group has no model configuration. Use /model to assign a preset after startup.',
      );
      continue;
    }

    // Read legacy fields (cast to any since they've been removed from the type)
    const config = group.containerConfig as any;
    const endpoint: string | undefined = config.endpoint;
    const model: string | undefined = config.model;

    // No endpoint — can't resolve
    if (!endpoint) {
      logger.warn(
        { jid, name: group.name },
        'Group has no endpoint configured. Use /model to assign a preset after startup.',
      );
      continue;
    }

    // No model — can't resolve
    if (!model) {
      errors.push({ jid, name: group.name, endpoint, model: '(none)' });
      continue;
    }

    // Try to find matching preset
    const presetName = findPresetByModelEndpoint(endpoint, model);
    if (!presetName) {
      errors.push({ jid, name: group.name, endpoint, model });
      continue;
    }

    // Build updated containerConfig: set preset, remove legacy fields
    const updatedConfig = { ...group.containerConfig } as any;
    updatedConfig.preset = presetName;
    delete updatedConfig.endpoint;
    delete updatedConfig.model;
    delete updatedConfig.webSearchVendor;
    delete updatedConfig.contextWindowSize;

    updates.push({
      jid,
      group: { ...group, containerConfig: updatedConfig },
    });

    logger.info(
      { jid, name: group.name, preset: presetName, endpoint, model },
      'Resolved group to preset',
    );
  }

  // 5. If errors, fail loudly
  if (errors.length > 0) {
    logger.error('=== PRESET MIGRATION FAILED ===');
    for (const err of errors) {
      logger.error(
        {
          jid: err.jid,
          name: err.name,
          endpoint: err.endpoint,
          model: err.model,
        },
        'Cannot resolve group to a preset',
      );
    }
    logger.error(
      'FATAL: Cannot migrate groups to presets. Create matching presets in ' +
        '~/.config/nanoclaw/model-presets.json for the above models, then restart.',
    );
    logger.info({ backupPath }, 'DB backup available for recovery');
    process.exit(1);
  }

  // 6. Save all updated groups inside a transaction (all-or-nothing)
  runInTransaction(() => {
    for (const { jid, group } of updates) {
      setRegisteredGroup(jid, group);
    }
  });

  // 7. Write marker file
  fs.writeFileSync(MARKER_FILE, new Date().toISOString());
  logger.info(
    { migratedCount: updates.length },
    'Preset migration complete (001-preset-migration)',
  );
}
