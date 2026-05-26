import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import type { AvailableGroup } from './container-runner.js';
import { getAllChats, setRegisteredGroup, storeChatMetadata } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { findChannel } from './router.js';
import { Channel, RegisteredGroup } from './types.js';

// --- Private module state ---

let registeredGroups: Record<string, RegisteredGroup> = {};
let channelList: Channel[] = [];

// --- Getters ---

export function getRegisteredGroups(): Record<string, RegisteredGroup> {
  return registeredGroups;
}

export function getRegisteredGroup(jid: string): RegisteredGroup | undefined {
  return registeredGroups[jid];
}

// --- Setters ---

export function setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

// --- Channel injection (called once after connect) ---

export function setChannelList(list: Channel[]): void {
  channelList = list;
}

export function getChannelList(): Channel[] {
  return channelList;
}

// --- Registration ---

export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create chats table row for internal groups (required for message processing)
  if (jid.endsWith('@internal')) {
    storeChatMetadata(
      jid,
      new Date().toISOString(),
      group.name,
      'dashboard',
      false,
    );
  }

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'extracted-skills'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Seed memory file so @memory/MEMORY.md import works from first run
  const memoryFile = path.join(groupDir, 'memory', 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(
      memoryFile,
      '# Memory\n\nDurable facts and preferences. Updated by the agent during conversations.\n\n<!-- Agent: append facts below this line. Keep concise — one line per fact. -->\n',
    );
    logger.info({ folder: group.folder }, 'Created memory/MEMORY.md seed');
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

// --- Runtime update ---

/**
 * Runtime entry point for mutating a registered group's persistence and
 * propagating the change to the owning channel. Use this from runtime code
 * paths (host commands, dashboard updates, registration callbacks). Setup CLI,
 * migrations, and tests should keep using the raw `setRegisteredGroup` since
 * channels are not connected at those points.
 */
export async function updateRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  const channel = findChannel(channelList, jid);
  if (!channel) return;

  if (channel.onGroupUpdated) {
    try {
      await channel.onGroupUpdated(jid);
    } catch (err) {
      logger.warn(
        { jid, channel: channel.name, err },
        'onGroupUpdated hook failed',
      );
    }
  }
}

// --- Queries ---

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
