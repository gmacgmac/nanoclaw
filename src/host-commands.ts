import fs from 'fs';
import path from 'path';

import { HOME_DIR } from './config.js';
import { setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { isSenderAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export interface HostCommandCtx {
  jid: string;
  group: RegisteredGroup;
  sender: string;
  reply: (text: string) => Promise<void>;
}

interface ModelPreset {
  endpoint: string;
  model: string;
}

type ModelPresets = Record<string, ModelPreset>;

const PRESETS_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'model-presets.json',
);

function loadPresets(): ModelPresets {
  try {
    const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn({ path: PRESETS_PATH }, 'model-presets.json is not an object');
      return {};
    }
    const presets: ModelPresets = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'endpoint' in value &&
        'model' in value &&
        typeof (value as Record<string, unknown>).endpoint === 'string' &&
        typeof (value as Record<string, unknown>).model === 'string'
      ) {
        presets[key] = {
          endpoint: (value as Record<string, unknown>).endpoint as string,
          model: (value as Record<string, unknown>).model as string,
        };
      } else {
        logger.warn(
          { preset: key, path: PRESETS_PATH },
          'Skipping invalid model preset entry',
        );
      }
    }
    return presets;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn({ path: PRESETS_PATH }, 'model-presets.json not found');
    } else {
      logger.warn(
        { err, path: PRESETS_PATH },
        'Failed to load model-presets.json',
      );
    }
    return {};
  }
}

function findActivePreset(
  presets: ModelPresets,
  endpoint?: string,
  model?: string,
): string | undefined {
  for (const [name, preset] of Object.entries(presets)) {
    if (preset.endpoint === endpoint && preset.model === model) {
      return name;
    }
  }
  return undefined;
}

export async function handleHostCommand(
  msg: NewMessage,
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => void,
): Promise<boolean> {
  const text = msg.content.trim();
  if (!text.startsWith('/')) return false;

  const parts = text.slice(1).split(/\s+/);
  const commandName = parts[0];

  const allowed = ctx.group.containerConfig?.allowedHostCommands;
  if (!allowed?.includes(commandName)) {
    return false;
  }

  // Sender auth check
  const allowlistCfg = loadSenderAllowlist();
  if (!isSenderAllowed(ctx.jid, ctx.sender, allowlistCfg)) {
    await ctx.reply('Not authorised.');
    return true;
  }

  if (commandName === 'model') {
    return handleModelCommand(parts.slice(1), ctx, closeStdin);
  }

  // Unknown host command that is in the allowlist — shouldn't happen in practice,
  // but treat as consumed to avoid leaking to agent.
  await ctx.reply(`Unknown host command: /${commandName}`);
  return true;
}

async function handleModelCommand(
  args: string[],
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => void,
): Promise<boolean> {
  const presets = loadPresets();
  const presetNames = Object.keys(presets);

  if (args.length === 0) {
    // Report current preset
    const currentEndpoint = ctx.group.containerConfig?.endpoint ?? 'anthropic';
    const currentModel = ctx.group.containerConfig?.model;
    const activePreset = findActivePreset(presets, currentEndpoint, currentModel);

    if (presetNames.length === 0) {
      await ctx.reply('No profiles configured.');
      return true;
    }

    const lines = [
      `Active: ${activePreset ? `\`${activePreset}\`` : `${currentEndpoint} / ${currentModel ?? 'default'}`}`,
      '',
      'Available:',
      ...presetNames.map((n) => `  • \`${n}\``),
    ];
    await ctx.reply(lines.join('\n'));
    return true;
  }

  const presetName = args[0];
  const preset = presets[presetName];

  if (!preset) {
    await ctx.reply(
      `Unknown preset \`${presetName}\`. Available: ${presetNames.map((n) => `\`${n}\``).join(', ') || 'none'}`,
    );
    return true;
  }

  // Merge new model/endpoint into existing config
  const existingConfig = ctx.group.containerConfig ?? {};
  const newConfig = {
    ...existingConfig,
    model: preset.model,
    endpoint: preset.endpoint,
  };

  const updatedGroup: RegisteredGroup = {
    ...ctx.group,
    containerConfig: newConfig,
  };

  setRegisteredGroup(ctx.jid, updatedGroup);

  // Sync in-memory cache
  (ctx.group as RegisteredGroup).containerConfig = newConfig;

  // Recycle active container so next message picks up new config
  closeStdin(ctx.jid);

  await ctx.reply(`Switched to \`${presetName}\` (${preset.endpoint} / ${preset.model}).`);
  return true;
}
