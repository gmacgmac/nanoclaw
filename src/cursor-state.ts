import { ASSISTANT_NAME } from './config.js';
import {
  getLastBotMessageTimestamp,
  getRouterState,
  setRouterState,
} from './db.js';
import { logger } from './logger.js';

// --- Private module state ---

let globalCursor = '';
let groupCursors: Record<string, string> = {};

// --- Internal persist helpers ---

async function persistGlobal(): Promise<void> {
  await setRouterState('last_timestamp', globalCursor);
}

async function persistGroups(): Promise<void> {
  await setRouterState('last_agent_timestamp', JSON.stringify(groupCursors));
}

// --- Exported getters ---

export function getGlobalCursor(): string {
  return globalCursor;
}

export function getGroupCursor(jid: string): string | undefined {
  return groupCursors[jid];
}

// --- Hydration ---

export async function loadCursors(): Promise<void> {
  globalCursor = (await getRouterState('last_timestamp')) || '';
  const agentTs = await getRouterState('last_agent_timestamp');
  try {
    groupCursors = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    groupCursors = {};
  }
}

// --- Setters ---

export async function setGlobalCursor(ts: string): Promise<void> {
  globalCursor = ts;
  await persistGlobal();
}

export async function setGroupCursor(jid: string, ts: string): Promise<void> {
  groupCursors[jid] = ts;
  await persistGroups();
}

export async function rollbackGroupCursor(
  jid: string,
  prev: string,
): Promise<void> {
  groupCursors[jid] = prev;
  await persistGroups();
}

// --- Recovery ---

export async function getOrRecoverGroupCursor(jid: string): Promise<string> {
  const existing = groupCursors[jid];
  if (existing) return existing;

  const botTs = await getLastBotMessageTimestamp(jid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid: jid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    groupCursors[jid] = botTs;
    await persistGroups();
    return botTs;
  }
  return '';
}
