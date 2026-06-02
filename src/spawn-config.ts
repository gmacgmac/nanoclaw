/**
 * resolveSpawnConfig — single per-spawn chokepoint for behaviour-shaping config.
 *
 * Re-reads group config fresh from DB (not the in-memory cache), resolves the
 * preset, loads the tool allowlist, and computes all governance values. Called
 * by all three spawn paths (live, scheduled, nightly nudge) so config edits
 * take effect on the next spawn without a host restart.
 *
 * The in-memory group cache (group-registry.ts) is NOT touched here — it
 * remains the source for iteration paths (message loop, recovery, scheduler
 * discovery, snapshot writer).
 */

import { getRegisteredGroup as getRegisteredGroupFromDb } from './db.js';
import { getRegisteredGroup as getRegisteredGroupFromCache } from './group-registry.js';
import { loadToolAllowlist } from './config.js';
import { validateContainerConfig } from './lib/config-validator.js';
import { resolvePreset, ResolvedPreset } from './presets.js';
import { logger } from './logger.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

export interface ResolvedSpawnConfig {
  /** The group object (fresh from DB, fallback to cache). */
  group: RegisteredGroup;
  /** Validated containerConfig (warnings logged, safe defaults applied). */
  containerConfig: ContainerConfig;
  /** Warnings from config validation (already logged). */
  configWarnings: Array<{ field: string; message: string; fallback: unknown }>;
  /** Resolved preset (null if resolution failed). */
  preset: ResolvedPreset | null;
  /** Tool allowlist ceiling (fresh read from tool-allowlist.json). */
  toolAllowlist: string[];
  /** Per-group denied tools (from containerConfig). */
  deniedTools: string[];
  /** Whether native web tools are enabled (from preset capabilities). */
  nativeWebTools: boolean;
  /** Approval mode (from containerConfig, defaults true). */
  approvalMode: boolean;
  /** Effective allowedTools after approval swap (Bash removed if approvalMode). */
  effectiveAllowedTools: string[] | undefined;
}

/**
 * Resolve all behaviour-shaping config for a spawn. Reads fresh from DB.
 * Returns null only if the group cannot be found at all (neither DB nor cache).
 */
export function resolveSpawnConfig(
  chatJid: string,
): ResolvedSpawnConfig | null {
  // Fresh DB read — the authoritative source for per-spawn config.
  // Falls back to the in-memory cache if the DB read fails (e.g. row deleted
  // between scheduler discovery and spawn).
  const dbGroup = getRegisteredGroupFromDb(chatJid);
  const cacheGroup = getRegisteredGroupFromCache(chatJid);
  const group = dbGroup ?? cacheGroup;

  if (!group) {
    logger.warn(
      { chatJid },
      'resolveSpawnConfig: group not found in DB or cache',
    );
    return null;
  }

  // Strip the `jid` field that the DB getter adds (RegisteredGroup doesn't have it)
  const { jid: _jid, ...groupWithoutJid } = group as RegisteredGroup & {
    jid?: string;
  };
  const cleanGroup: RegisteredGroup = groupWithoutJid;

  // Validate containerConfig — log warnings, use safe defaults
  const { config: validatedConfig, warnings: configWarnings } =
    validateContainerConfig(cleanGroup.containerConfig);
  for (const w of configWarnings) {
    logger.warn(
      { chatJid, field: w.field, fallback: w.fallback },
      `resolveSpawnConfig validation: ${w.message}`,
    );
  }

  // Resolve preset (fresh read — loadPresets reads file each call)
  const preset = resolvePreset(cleanGroup.containerConfig?.preset);

  // Tool allowlist ceiling (fresh read from file)
  const toolAllowlist = loadToolAllowlist();

  // Per-group denied tools
  const deniedTools = validatedConfig.deniedTools ?? [];

  // Native web tools (from preset capabilities)
  const nativeWebTools = preset?.capabilities?.nativeWebTools === true;

  // Approval mode (defaults true)
  const approvalMode = validatedConfig.approvalMode !== false;

  // Effective allowedTools: remove Bash when approvalMode is active
  let effectiveAllowedTools = validatedConfig.allowedTools;
  if (approvalMode && effectiveAllowedTools) {
    effectiveAllowedTools = effectiveAllowedTools.filter((t) => t !== 'Bash');
  }

  return {
    group: cleanGroup,
    containerConfig: validatedConfig,
    configWarnings,
    preset,
    toolAllowlist,
    deniedTools,
    nativeWebTools,
    approvalMode,
    effectiveAllowedTools,
  };
}
