import { ASSISTANT_NAME } from './config.js';
import {
  getLastBotMessageTimestamp,
  getRouterState,
  setRouterState,
} from './db.js';
import { logger } from './logger.js';

// --- Cursor type ---

export interface Cursor {
  ts: string; // ISO timestamp
  id: string; // messages.id (bigserial PK as string)
}

export const ZERO_CURSOR: Cursor = { ts: '', id: '0' };

// --- Private module state ---

let globalCursor: Cursor = { ...ZERO_CURSOR };
let groupCursors: Record<string, Cursor> = {};

// --- Internal persist helpers ---

async function persistGlobal(): Promise<void> {
  await setRouterState('last_timestamp', JSON.stringify(globalCursor));
}

async function persistGroups(): Promise<void> {
  await setRouterState('last_agent_timestamp', JSON.stringify(groupCursors));
}

// --- Exported getters ---

export function getGlobalCursor(): Cursor {
  return globalCursor;
}

export function getGroupCursor(jid: string): Cursor | undefined {
  return groupCursors[jid];
}

// --- Hydration ---

export async function loadCursors(): Promise<void> {
  const raw = await getRouterState('last_timestamp');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        parsed.ts !== undefined
      ) {
        globalCursor = parsed; // Already composite
      } else {
        // Legacy: bare timestamp string that was valid JSON (e.g. a quoted string)
        globalCursor = { ts: raw, id: '0' };
      }
    } catch {
      // Legacy: bare timestamp string (not valid JSON)
      globalCursor = { ts: raw, id: '0' };
    }
  }

  const agentTs = await getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs ? JSON.parse(agentTs) : {};
    // Detect shape: if first value is a string, migrate all entries
    const firstValue = Object.values(parsed)[0];
    if (typeof firstValue === 'string') {
      // Legacy: { jid: "timestamp" } → { jid: { ts: "timestamp", id: "0" } }
      groupCursors = Object.fromEntries(
        Object.entries(parsed).map(([jid, ts]) => [
          jid,
          { ts: ts as string, id: '0' },
        ]),
      );
    } else {
      groupCursors = parsed;
    }
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    groupCursors = {};
  }
}

// --- Setters ---

export async function setGlobalCursor(cursor: Cursor): Promise<void> {
  globalCursor = cursor;
  await persistGlobal();
}

export async function setGroupCursor(
  jid: string,
  cursor: Cursor,
): Promise<void> {
  groupCursors[jid] = cursor;
  await persistGroups();
}

export async function rollbackGroupCursor(
  jid: string,
  prev: Cursor,
): Promise<void> {
  groupCursors[jid] = prev;
  await persistGroups();
}

// --- Recovery ---

export async function getOrRecoverGroupCursor(jid: string): Promise<Cursor> {
  const existing = groupCursors[jid];
  if (existing) return existing;

  const botTs = await getLastBotMessageTimestamp(jid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid: jid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    const recovered: Cursor = { ts: botTs, id: '0' };
    groupCursors[jid] = recovered;
    await persistGroups();
    return recovered;
  }
  return { ...ZERO_CURSOR };
}

// --- Helpers ---

export function cursorFromMessage(msg: {
  timestamp: string;
  id: string;
}): Cursor {
  return { ts: msg.timestamp, id: msg.id };
}

export function cursorIsAfter(a: Cursor, b: Cursor): boolean {
  if (a.ts > b.ts) return true;
  if (a.ts === b.ts && a.id > b.id) return true;
  return false;
}
