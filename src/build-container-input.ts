/**
 * buildContainerInput — centralised factory for assembling ContainerInput.
 *
 * All three spawn paths (chat, nightly-nudge, task-scheduler) use this factory
 * instead of duplicating field assembly. New fields are added here once.
 */

import { ContainerInput } from './container-runner.js';
import { ASSISTANT_NAME } from './config.js';
import { ResolvedSpawnConfig } from './spawn-config.js';
import { ResolvedPreset } from './presets.js';
import { scanEndpoints } from './env.js';

/**
 * Per-spawn overrides — fields that differ between chat, nudge, and task paths.
 * `prompt` and `chatJid` are required; everything else is optional.
 */
export interface ContainerInputOverrides {
  prompt: string;
  chatJid: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  nudgeInterval?: number;
  images?: ContainerInput['images'];
  approvalTimeout?: number;
  commandAllowlist?: string[];
  script?: string;
  promptReminder?: string;
}

/**
 * Resolve awsRegion for the effective preset.
 * Only applies when sdkMode === 'bedrock' and endpoint is set.
 */
function resolveAwsRegion(preset: ResolvedPreset): string | undefined {
  if (preset.sdkMode === 'bedrock' && preset.endpoint) {
    const routingTable = scanEndpoints();
    return routingTable[preset.endpoint]?.region;
  }
  return undefined;
}

/**
 * Build a complete ContainerInput from resolved spawn config + effective preset
 * + per-spawn overrides.
 *
 * Base fields come from spawnConfig/preset (single source of truth).
 * Overrides are per-spawn (prompt, sessionId, images, nudgeInterval, etc.).
 * New fields are added here once — all spawn paths benefit automatically.
 */
export function buildContainerInput(
  spawnConfig: ResolvedSpawnConfig,
  preset: ResolvedPreset,
  overrides: ContainerInputOverrides,
): ContainerInput {
  const { group, containerConfig } = spawnConfig;

  return {
    // --- Base fields (from spawnConfig + preset) ---
    groupFolder: group.folder,
    chatJid: overrides.chatJid,
    isMain: group.isMain === true,
    isAdmin: group.isAdmin === true,
    assistantName: ASSISTANT_NAME,
    model: preset.model,
    systemPrompt: containerConfig.systemPrompt,
    mcpServers: containerConfig.mcpServers,
    endpoint: preset.endpoint,
    transform: preset.transform,
    sdkMode: preset.sdkMode,
    awsRegion: resolveAwsRegion(preset),
    webSearchVendor: preset.webSearchVendor,
    contextWindowSize: preset.contextWindow,
    learningLoop: containerConfig.learningLoop,

    // --- Per-spawn overrides ---
    prompt: overrides.prompt,
    sessionId: overrides.sessionId,
    isScheduledTask: overrides.isScheduledTask,
    nudgeInterval: overrides.nudgeInterval,
    approvalTimeout: overrides.approvalTimeout,
    commandAllowlist: overrides.commandAllowlist,
    images: overrides.images,
    script: overrides.script,
    promptReminder: overrides.promptReminder,
  };
}
