import { setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { getAvailablePresetNames, resolvePreset } from './presets.js';
import { sanitizeSessionJsonl } from './session-sanitizer.js';
import { isSenderAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// Feature toggle: sanitize session JSONL when switching models
// If this causes issues, set to false to disable entirely
const SANITIZE_SESSION_ON_SWITCH = true;

export interface HostCommandCtx {
  jid: string;
  group: RegisteredGroup;
  sender: string;
  reply: (text: string) => Promise<void>;
}

export async function handleHostCommand(
  msg: NewMessage,
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => boolean,
  clearSession?: (groupFolder: string) => void,
): Promise<boolean> {
  const text = msg.content.trim();
  if (!text.startsWith('/')) return false;

  const parts = text.slice(1).split(/\s+/);
  const commandName = parts[0].toLowerCase();

  // --- Ungated commands (available to all groups, no allowedHostCommands check) ---

  if (commandName === 'shutdown') {
    // Sender auth check
    const allowlistCfg = loadSenderAllowlist();
    if (!isSenderAllowed(ctx.jid, ctx.sender, allowlistCfg)) {
      await ctx.reply('Not authorised.');
      return true;
    }

    const stopped = closeStdin(ctx.jid);
    if (stopped) {
      logger.info(
        { group: ctx.group.name, sender: ctx.sender },
        '/shutdown command executed',
      );
      await ctx.reply(
        'Container stopped. Next message will start a new container with the same session.',
      );
    } else {
      await ctx.reply('No container running for this group.');
    }
    return true;
  }

  if (commandName === 'stop') {
    // Sender auth check
    const allowlistCfg = loadSenderAllowlist();
    if (!isSenderAllowed(ctx.jid, ctx.sender, allowlistCfg)) {
      await ctx.reply('Not authorised.');
      return true;
    }

    const stopped = closeStdin(ctx.jid);
    if (stopped) {
      logger.info(
        { group: ctx.group.name, sender: ctx.sender },
        '/stop command executed',
      );
      await ctx.reply('⏹ Stopped. Next message continues the conversation.');
    } else {
      await ctx.reply('Nothing running to stop.');
    }
    return true;
  }

  // --- Gated commands (require allowedHostCommands config) ---

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

  if (commandName === 'newsession') {
    return handleNewSessionCommand(ctx, closeStdin, clearSession);
  }

  // Unknown host command that is in the allowlist — shouldn't happen in practice,
  // but treat as consumed to avoid leaking to agent.
  await ctx.reply(`Unknown host command: /${commandName}`);
  return true;
}

async function handleModelCommand(
  args: string[],
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => boolean,
): Promise<boolean> {
  const presetNames = getAvailablePresetNames();

  if (args.length === 0) {
    // Report current preset and list available
    if (presetNames.length === 0) {
      await ctx.reply('No profiles configured.');
      return true;
    }

    const currentPresetName = ctx.group.containerConfig?.preset;
    const resolved = resolvePreset(currentPresetName);

    const activeLine = resolved
      ? `Active: \`${resolved.name}\``
      : currentPresetName
        ? `Active: \`${currentPresetName}\` (unresolved)`
        : 'Active: none';

    const lines = [
      activeLine,
      '',
      'Available:',
      ...presetNames.map((n) => `  • \`${n}\``),
    ];
    await ctx.reply(lines.join('\n'));
    return true;
  }

  const presetName = args[0];
  const resolved = resolvePreset(presetName);

  if (!resolved) {
    await ctx.reply(
      `Unknown preset \`${presetName}\`. Available: ${presetNames.map((n) => `\`${n}\``).join(', ') || 'none'}`,
    );
    return true;
  }

  // Set preset name on config — only the name is stored, resolution happens at spawn
  const existingConfig = ctx.group.containerConfig ?? {};
  const newConfig = {
    ...existingConfig,
    preset: presetName,
  };

  const updatedGroup: RegisteredGroup = {
    ...ctx.group,
    containerConfig: newConfig,
  };

  setRegisteredGroup(ctx.jid, updatedGroup);

  // Sync in-memory cache
  (ctx.group as RegisteredGroup).containerConfig = newConfig;

  // Recycle active container so next message picks up new config.
  // settings.json is regenerated on spawn — no need to update it here.
  closeStdin(ctx.jid);

  if (SANITIZE_SESSION_ON_SWITCH) {
    try {
      sanitizeSessionJsonl(ctx.group.folder);
    } catch (err) {
      logger.warn(
        { err, folder: ctx.group.folder },
        'Session sanitization failed — proceeding anyway',
      );
    }
  }

  await ctx.reply(
    `Switched to \`${presetName}\` (${resolved.endpoint} / ${resolved.model}).`,
  );
  return true;
}

async function handleNewSessionCommand(
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => boolean,
  clearSession?: (groupFolder: string) => void,
): Promise<boolean> {
  closeStdin(ctx.jid);
  clearSession?.(ctx.group.folder);

  logger.info(
    { group: ctx.group.name, sender: ctx.sender },
    '/newsession command executed — session cleared',
  );
  await ctx.reply('Session cleared. Next message starts fresh.');
  return true;
}
