import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { getAvailablePresetNames, resolvePreset } from './presets.js';
import { sanitizeSessionJsonl } from './session-sanitizer.js';
import { isSenderAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { isValidContainerChannel } from './types.js';
import type { ContainerChannel, NewMessage, RegisteredGroup } from './types.js';
import { resolveImageTag, CONTAINER_RUNTIME_BIN } from './container-runtime.js';

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
  onAfterExit: (groupJid: string, cb: () => Promise<void> | void) => void,
  clearSessionState: (groupFolder: string) => void,
): Promise<boolean> {
  const text = msg.content.trim();
  if (!text.startsWith('/')) return false;

  const parts = text.slice(1).split(/\s+/);
  // Strip Telegram's `@<botname>` suffix appended in group chats
  // (e.g. `/version@chocalotbot` → `version`). No-op for other channels.
  const commandName = parts[0].toLowerCase().split('@')[0];

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
      onAfterExit(ctx.jid, async () => {
        await ctx.reply(
          'Container stopped. Next message will start a new container with the same session.',
        );
      });
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
      onAfterExit(ctx.jid, async () => {
        await ctx.reply('⏹ Stopped. Next message continues the conversation.');
      });
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
    return handleModelCommand(parts.slice(1), ctx, closeStdin, onAfterExit);
  }

  if (commandName === 'newsession') {
    return handleNewSessionCommand(
      ctx,
      closeStdin,
      onAfterExit,
      clearSessionState,
    );
  }

  if (commandName === 'version') {
    return handleVersionCommand(parts.slice(1), ctx, closeStdin, onAfterExit);
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
  onAfterExit: (groupJid: string, cb: () => Promise<void> | void) => void,
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

  // Sync in-memory cache
  (ctx.group as RegisteredGroup).containerConfig = newConfig;

  await ctx.reply(`Switching to \`${presetName}\`...`);
  closeStdin(ctx.jid);

  onAfterExit(ctx.jid, async () => {
    setRegisteredGroup(ctx.jid, updatedGroup);

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
  });

  return true;
}

async function handleNewSessionCommand(
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => boolean,
  onAfterExit: (groupJid: string, cb: () => Promise<void> | void) => void,
  clearSessionState: (groupFolder: string) => void,
): Promise<boolean> {
  await ctx.reply('Clearing session...');
  closeStdin(ctx.jid);

  onAfterExit(ctx.jid, async () => {
    clearSessionState(ctx.group.folder);
    logger.info(
      { group: ctx.group.name, sender: ctx.sender },
      '/newsession command executed — session cleared',
    );
    await ctx.reply('Session cleared. Next message starts fresh.');
  });

  return true;
}

// --- /version command ---

interface VersionsJson {
  channels: Record<string, string>;
  versions: Record<
    string,
    {
      imageId: string;
      sdkVersion: string;
      cliVersion: string;
    }
  >;
}

/**
 * Read VERSIONS.json fresh on every invocation (no caching).
 * Returns null if the file is missing or malformed.
 */
function readVersionsJson(): VersionsJson | null {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const versionsPath = path.join(
      __dirname,
      '..',
      'container',
      'VERSIONS.json',
    );
    const raw = fs.readFileSync(versionsPath, 'utf-8');
    return JSON.parse(raw) as VersionsJson;
  } catch {
    return null;
  }
}

async function handleVersionCommand(
  args: string[],
  ctx: HostCommandCtx,
  closeStdin: (jid: string) => boolean,
  onAfterExit: (groupJid: string, cb: () => Promise<void> | void) => void,
): Promise<boolean> {
  const channel = ctx.group.containerChannel ?? 'stable';

  // Form 1: /version (no args) — read-only info
  if (args.length === 0) {
    const imageTag = resolveImageTag(channel);
    const versions = readVersionsJson();

    if (!versions) {
      await ctx.reply(
        '⚠️ Could not read VERSIONS.json. Run `container.sh current` to inspect manually.',
      );
      return true;
    }

    const versionName = versions.channels[channel] ?? 'unknown';
    const versionInfo = versions.versions[versionName];

    const lines = [
      `📦 Container channel for this group: ${channel}`,
      `Image: ${imageTag} → ${versionName}`,
    ];

    if (versionInfo) {
      lines.push(
        `SDK: @anthropic-ai/claude-agent-sdk@${versionInfo.sdkVersion}`,
      );
      lines.push(`CLI: @anthropic-ai/claude-code@${versionInfo.cliVersion}`);

      // Drift detection: check if the actual image SHA matches VERSIONS.json
      try {
        const inspectOutput = execSync(
          `${CONTAINER_RUNTIME_BIN} image inspect ${imageTag} --format '{{.Id}}'`,
          { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
        ).trim();
        if (
          inspectOutput &&
          !inspectOutput.includes(versionInfo.imageId.replace('sha256:', ''))
        ) {
          lines.push(
            `⚠️ Tag :${channel} does not match VERSIONS.json — run \`container.sh current\` to investigate.`,
          );
        }
      } catch {
        // Image not found locally or docker not available — skip drift check
      }
    } else {
      lines.push(
        `(version details not found in VERSIONS.json for ${versionName})`,
      );
    }

    await ctx.reply(lines.join('\n'));
    return true;
  }

  // Form 2/3: /version <channel> — switch channel
  const requestedChannel = args[0].toLowerCase();

  if (!isValidContainerChannel(requestedChannel)) {
    await ctx.reply(
      `❌ Invalid channel: \`${args[0]}\`. Valid options: \`stable\`, \`next\`.`,
    );
    return true;
  }

  // Resolve target tag for the user-facing reply.
  // Note: we don't pre-check whether the image exists. `docker image inspect`
  // is unreliable on Docker Desktop (intermittent false negatives), and the
  // next message will fail loudly with a clear docker error if the tag is
  // genuinely missing — at which point the user can switch back.
  const targetTag = resolveImageTag(requestedChannel);

  // Update DB
  const updatedGroup: RegisteredGroup = {
    ...ctx.group,
    containerChannel: requestedChannel as ContainerChannel,
  };

  // Sync in-memory cache
  (ctx.group as RegisteredGroup).containerChannel =
    requestedChannel as ContainerChannel;

  await ctx.reply(`Switching to channel \`${requestedChannel}\`...`);
  closeStdin(ctx.jid);

  onAfterExit(ctx.jid, async () => {
    setRegisteredGroup(ctx.jid, updatedGroup);
    logger.info(
      { group: ctx.group.name, sender: ctx.sender, channel: requestedChannel },
      '/version command — channel switched',
    );
    await ctx.reply(
      `✅ Switched to channel: ${requestedChannel}. The next message will spawn a new container using ${targetTag}.`,
    );
  });

  return true;
}
