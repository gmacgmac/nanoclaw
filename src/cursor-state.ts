import { ASSISTANT_NAME } from './config.js';
import { getLastBotMessageTimestamp, getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';

// --- Private module state ---

let globalCursor = '';
let groupCursors: Record<string, string> = {};

// --- Internal persist helpers ---

function persistGlobal(): void {
  setRouterState('last_timestamp', globalCursor);
}

function persistGroups(): void {
  setRouterState('last_agent_timestamp', JSON.stringify(groupCursors));
}

// --- Exported getters ---

export function getGlobalCursor(): string {
  return globalCursor;
}

export function getGroupCursor(jid: string): string | undefined {
  return groupCursors[jid];
}

// --- Hydration ---

export function loadCursors(): void {
  globalCursor = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    groupCursors = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    groupCursors = {};
  }
}

// --- Setters ---

export function setGlobalCursor(ts: string): void {
  globalCursor = ts;
  persistGlobal();
}

export function setGroupCursor(jid: string, ts: string): void {
  groupCursors[jid] = ts;
  persistGroups();
}

export function rollbackGroupCursor(jid: string, prev: string): void {
  groupCursors[jid] = prev;
  persistGroups();
}

// --- Recovery ---

export function getOrRecoverGroupCursor(jid: string): string {
  const existing = groupCursors[jid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(jid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid: jid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    groupCursors[jid] = botTs;
    persistGroups();
    return botTs;
  }
  return '';
}
