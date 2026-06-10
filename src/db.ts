import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, DATABASE_URL } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger, setDbErrorLogger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  isValidContainerChannel,
} from './types.js';

// --- postgres.js client ---

let sql: postgres.Sql;

/** Convert a Date or string timestamp from PG to ISO string */
function toIso(val: Date | string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}

// --- Schema creation ---

async function createSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TIMESTAMPTZ,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TIMESTAMPTZ,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)`;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TIMESTAMPTZ,
      last_run TIMESTAMPTZ,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS delegations (
      uuid TEXT PRIMARY KEY,
      caller_jid TEXT NOT NULL,
      target_jid TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS error_log (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp)`;

  // --- Migrations (idempotent) ---

  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS context_mode TEXT DEFAULT 'isolated'`;
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS script TEXT`;
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS description TEXT`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_bot_message INTEGER DEFAULT 0`;
  await sql`ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS is_main INTEGER DEFAULT 0`;
  await sql`ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0`;
  await sql`ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS multi_agent_router INTEGER DEFAULT 0`;
  await sql`ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS container_channel TEXT NOT NULL DEFAULT 'stable'`;
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS channel TEXT`;
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_group INTEGER DEFAULT 0`;

  // Dashboard chat log table
  await sql`
    CREATE TABLE IF NOT EXISTS dashboard_chat_log (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      is_from_user INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dashboard_chat_log_jid_ts ON dashboard_chat_log(chat_jid, timestamp)`;
}

// --- Lifecycle ---

export async function initDatabase(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. See README.md §PostgreSQL Setup for configuration instructions.',
    );
  }

  sql = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 1800, // recycle connections after 30 min — handles PG restarts
    onnotice: () => {}, // suppress DDL notices (e.g. "column already exists")
  });

  await createSchema();

  // Migrate from JSON files if they exist
  await migrateJsonState();

  // Set up DB error logging (avoids circular dependency)
  setDbErrorLogger((level, message, context) => {
    logError({
      level: level as 'error' | 'fatal' | 'warn',
      message,
      context,
    }).catch(() => {
      // Ignore logging errors to prevent infinite loops
    });
  });
}

/** @internal - for tests only. Drops and recreates all tables. */
export async function _initTestDatabase(testUrl?: string): Promise<void> {
  const url = testUrl || DATABASE_URL;
  if (!url) {
    throw new Error('No DATABASE_URL available for test database');
  }

  sql = postgres(url, { max: 5 });

  // Drop all tables for a clean slate
  await sql`DROP TABLE IF EXISTS dashboard_chat_log CASCADE`;
  await sql`DROP TABLE IF EXISTS error_log CASCADE`;
  await sql`DROP TABLE IF EXISTS delegations CASCADE`;
  await sql`DROP TABLE IF EXISTS task_run_logs CASCADE`;
  await sql`DROP TABLE IF EXISTS scheduled_tasks CASCADE`;
  await sql`DROP TABLE IF EXISTS sessions CASCADE`;
  await sql`DROP TABLE IF EXISTS router_state CASCADE`;
  await sql`DROP TABLE IF EXISTS messages CASCADE`;
  await sql`DROP TABLE IF EXISTS chats CASCADE`;
  await sql`DROP TABLE IF EXISTS registered_groups CASCADE`;

  await createSchema();
}

export async function shutdownDatabase(): Promise<void> {
  if (sql) {
    await sql.end();
  }
}

// --- Chat operations ---

/**
 * Store chat metadata only (no message content).
 */
export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;
  const displayName = name || chatJid;
  const hasName = name != null;

  await sql`
    INSERT INTO chats (jid, name, last_message_time, channel, is_group)
    VALUES (${chatJid}, ${displayName}, ${timestamp}, ${ch}, ${group})
    ON CONFLICT (jid) DO UPDATE SET
      name = CASE WHEN ${hasName}::boolean THEN ${displayName} ELSE chats.name END,
      last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
      channel = COALESCE(EXCLUDED.channel, chats.channel),
      is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
  `;
}

/**
 * Update chat name without changing timestamp for existing chats.
 */
export async function updateChatName(
  chatJid: string,
  name: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO chats (jid, name, last_message_time)
    VALUES (${chatJid}, ${name}, ${now})
    ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name
  `;
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export async function getAllChats(): Promise<ChatInfo[]> {
  const rows = await sql`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `;
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    last_message_time: toIso(r.last_message_time) || '',
    channel: r.channel,
    is_group: r.is_group,
  }));
}

/**
 * Look up a single chat by its JID. Returns undefined if not found.
 */
export async function getChatByJid(jid: string): Promise<ChatInfo | undefined> {
  const rows = await sql`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    WHERE jid = ${jid}
  `;
  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    jid: r.jid,
    name: r.name,
    last_message_time: toIso(r.last_message_time) || '',
    channel: r.channel,
    is_group: r.is_group,
  };
}

/**
 * Get timestamp of last group metadata sync.
 */
export async function getLastGroupSync(): Promise<string | null> {
  const rows = await sql`
    SELECT last_message_time FROM chats WHERE jid = '__group_sync__'
  `;
  if (rows.length === 0) return null;
  return toIso(rows[0].last_message_time) || null;
}

/**
 * Record that group metadata was synced.
 */
export async function setLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO chats (jid, name, last_message_time)
    VALUES ('__group_sync__', '__group_sync__', ${now})
    ON CONFLICT (jid) DO UPDATE SET last_message_time = EXCLUDED.last_message_time
  `;
}

// --- Message operations ---

/**
 * Store a message with full content.
 */
export async function storeMessage(msg: NewMessage): Promise<void> {
  await sql`
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${msg.is_from_me ? 1 : 0}, ${msg.is_bot_message ? 1 : 0})
    ON CONFLICT (id, chat_jid) DO UPDATE SET
      content = EXCLUDED.content,
      sender_name = EXCLUDED.sender_name,
      is_bot_message = EXCLUDED.is_bot_message
  `;
}

/**
 * Store a message directly.
 */
export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  await sql`
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${msg.is_from_me ? 1 : 0}, ${msg.is_bot_message ? 1 : 0})
    ON CONFLICT (id, chat_jid) DO UPDATE SET
      content = EXCLUDED.content,
      sender_name = EXCLUDED.sender_name,
      is_bot_message = EXCLUDED.is_bot_message
  `;
}

/**
 * Store a message in the dashboard_chat_log table.
 */
export async function storeDashboardChatMessage(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_user: boolean;
}): Promise<void> {
  await sql`
    INSERT INTO dashboard_chat_log (id, chat_jid, sender, sender_name, content, timestamp, is_from_user)
    VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${msg.is_from_user ? 1 : 0})
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      sender_name = EXCLUDED.sender_name
  `;
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  // Empty string can't be cast to TIMESTAMPTZ — use epoch to return all messages
  const since = lastTimestamp || '1970-01-01T00:00:00.000Z';

  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const rows = await sql`
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ${since} AND chat_jid = ANY(${jids})
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub ORDER BY timestamp
  `;

  const messages: NewMessage[] = rows.map((r) => ({
    id: r.id,
    chat_jid: r.chat_jid,
    sender: r.sender,
    sender_name: r.sender_name,
    content: r.content,
    timestamp: toIso(r.timestamp) || '',
    is_from_me: r.is_from_me === 1 ? true : undefined,
  }));

  let newTimestamp = lastTimestamp;
  for (const msg of messages) {
    if (msg.timestamp > newTimestamp) newTimestamp = msg.timestamp;
  }

  return { messages, newTimestamp };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  // Empty string can't be cast to TIMESTAMPTZ — use epoch to return all messages
  const since = sinceTimestamp || '1970-01-01T00:00:00.000Z';
  const rows = await sql`
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ${chatJid} AND timestamp > ${since}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub ORDER BY timestamp
  `;

  return rows.map((r) => ({
    id: r.id,
    chat_jid: r.chat_jid,
    sender: r.sender,
    sender_name: r.sender_name,
    content: r.content,
    timestamp: toIso(r.timestamp) || '',
    is_from_me: r.is_from_me === 1 ? true : undefined,
  }));
}

export async function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): Promise<string | undefined> {
  const rows = await sql`
    SELECT MAX(timestamp) as ts FROM messages
    WHERE chat_jid = ${chatJid} AND (is_bot_message = 1 OR content LIKE ${botPrefix + ':%'})
  `;
  if (rows.length === 0 || rows[0].ts === null) return undefined;
  return toIso(rows[0].ts) ?? undefined;
}

/**
 * Delete all messages for a chat. Returns the number of rows deleted.
 * Destructive — caller should require explicit confirmation before invoking.
 */
export async function deleteMessagesForChat(chatJid: string): Promise<number> {
  const result = await sql`DELETE FROM messages WHERE chat_jid = ${chatJid}`;
  return result.count;
}

// --- Task operations ---

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await sql`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, description, schedule_type, schedule_value, context_mode, next_run, status, created_at, script)
    VALUES (${task.id}, ${task.group_folder}, ${task.chat_jid}, ${task.prompt}, ${task.description || null}, ${task.schedule_type}, ${task.schedule_value}, ${task.context_mode || 'isolated'}, ${task.next_run}, ${task.status}, ${task.created_at}, ${task.script || null})
  `;
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const rows = await sql`SELECT * FROM scheduled_tasks WHERE id = ${id}`;
  if (rows.length === 0) return undefined;
  return mapTask(rows[0]);
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  const rows = await sql`
    SELECT * FROM scheduled_tasks WHERE group_folder = ${groupFolder} ORDER BY created_at DESC
  `;
  return rows.map(mapTask);
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const rows =
    await sql`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`;
  return rows.map(mapTask);
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'description'
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'script'
      | 'context_mode'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.description !== undefined) {
    fields.push('description');
    values.push(updates.description);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status');
    values.push(updates.status);
  }
  if (updates.script !== undefined) {
    fields.push('script');
    values.push(updates.script);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode');
    values.push(updates.context_mode);
  }

  if (fields.length === 0) return;

  // Build a plain object for the SET clause; only include defined fields
  const setObj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i++) {
    setObj[fields[i]] = values[i];
  }

  await sql`
    UPDATE scheduled_tasks SET ${sql(setObj, ...fields)} WHERE id = ${id}
  `;
}

export async function deleteTask(id: string): Promise<void> {
  // Proper transaction wrapping (was implicit in SQLite)
  await sql.begin(async (tx) => {
    await tx`DELETE FROM task_run_logs WHERE task_id = ${id}`;
    await tx`DELETE FROM scheduled_tasks WHERE id = ${id}`;
  });
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const rows = await sql`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ${now}
    ORDER BY next_run
  `;
  return rows.map(mapTask);
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    UPDATE scheduled_tasks
    SET next_run = ${nextRun}, last_run = ${now}, last_result = ${lastResult},
        status = CASE WHEN ${nextRun} IS NULL THEN 'completed' ELSE status END
    WHERE id = ${id}
  `;
}

/**
 * Write completion metadata after a task run finishes.
 */
export async function updateTaskAfterCompletion(
  id: string,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    UPDATE scheduled_tasks
    SET last_run = ${now}, last_result = ${lastResult},
        status = CASE WHEN next_run IS NULL THEN 'completed' ELSE status END
    WHERE id = ${id}
  `;
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await sql`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (${log.task_id}, ${log.run_at}, ${log.duration_ms}, ${log.status}, ${log.result}, ${log.error})
  `;
}

/**
 * Insert a 'started' sentinel row at the beginning of a task run.
 * Returns the row ID so it can be updated on completion.
 */
export async function logTaskRunStarted(
  taskId: string,
  runAt: string,
): Promise<number> {
  const rows = await sql`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (${taskId}, ${runAt}, 0, 'started', NULL, NULL)
    RETURNING id
  `;
  return Number(rows[0].id);
}

/**
 * Update an existing task_run_logs row (transition from 'started' to final state).
 */
export async function updateTaskRunLog(
  rowId: number,
  updates: {
    status: 'success' | 'error';
    result?: string | null;
    error?: string | null;
    duration_ms?: number;
  },
): Promise<void> {
  await sql`
    UPDATE task_run_logs
    SET status = ${updates.status}, result = ${updates.result ?? null}, error = ${updates.error ?? null}, duration_ms = ${updates.duration_ms ?? 0}
    WHERE id = ${rowId}
  `;
}

export interface OrphanedRunLog {
  id: number;
  task_id: string;
  run_at: string;
}

/**
 * Find all task_run_logs rows still in 'started' status (orphaned by a crash).
 */
export async function getOrphanedStartedRuns(): Promise<OrphanedRunLog[]> {
  const rows = await sql`
    SELECT id, task_id, run_at FROM task_run_logs WHERE status = 'started'
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    task_id: r.task_id,
    run_at: toIso(r.run_at) || '',
  }));
}

// --- Router state accessors ---

export async function getRouterState(key: string): Promise<string | undefined> {
  const rows = await sql`SELECT value FROM router_state WHERE key = ${key}`;
  if (rows.length === 0) return undefined;
  return rows[0].value;
}

export async function setRouterState(
  key: string,
  value: string,
): Promise<void> {
  await sql`
    INSERT INTO router_state (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

// --- Session accessors ---

export async function getSession(
  groupFolder: string,
): Promise<string | undefined> {
  const rows =
    await sql`SELECT session_id FROM sessions WHERE group_folder = ${groupFolder}`;
  if (rows.length === 0) return undefined;
  return rows[0].session_id;
}

export async function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  await sql`
    INSERT INTO sessions (group_folder, session_id) VALUES (${groupFolder}, ${sessionId})
    ON CONFLICT (group_folder) DO UPDATE SET session_id = EXCLUDED.session_id
  `;
}

export async function deleteSession(groupFolder: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE group_folder = ${groupFolder}`;
}

export async function getAllSessions(): Promise<Record<string, string>> {
  const rows = await sql`SELECT group_folder, session_id FROM sessions`;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const rows = await sql`SELECT * FROM registered_groups WHERE jid = ${jid}`;
  if (rows.length === 0) return undefined;
  const row = rows[0];

  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  const channel = row.container_channel ?? 'stable';
  if (!isValidContainerChannel(channel)) {
    logger.warn(
      { jid: row.jid, container_channel: channel },
      'Invalid container_channel value, falling back to stable',
    );
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: toIso(row.added_at) || '',
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    isAdmin: row.is_admin === 1 ? true : undefined,
    multiAgentRouter: row.multi_agent_router === 1 ? true : undefined,
    containerChannel: isValidContainerChannel(channel) ? channel : 'stable',
  };
}

export async function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  const channel = group.containerChannel ?? 'stable';
  if (!isValidContainerChannel(channel)) {
    throw new Error(
      `Invalid container_channel "${channel}" for JID ${jid}. Must be 'stable' or 'next'.`,
    );
  }
  await sql`
    INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, is_admin, multi_agent_router, container_channel)
    VALUES (${jid}, ${group.name}, ${group.folder}, ${group.trigger}, ${group.added_at}, ${group.containerConfig ? JSON.stringify(group.containerConfig) : null}, ${group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0}, ${group.isMain ? 1 : 0}, ${group.isAdmin ? 1 : 0}, ${group.multiAgentRouter ? 1 : 0}, ${channel})
    ON CONFLICT (jid) DO UPDATE SET
      name = EXCLUDED.name,
      folder = EXCLUDED.folder,
      trigger_pattern = EXCLUDED.trigger_pattern,
      added_at = EXCLUDED.added_at,
      container_config = EXCLUDED.container_config,
      requires_trigger = EXCLUDED.requires_trigger,
      is_main = EXCLUDED.is_main,
      is_admin = EXCLUDED.is_admin,
      multi_agent_router = EXCLUDED.multi_agent_router,
      container_channel = EXCLUDED.container_channel
  `;
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const rows = await sql`SELECT * FROM registered_groups`;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    const channel = row.container_channel ?? 'stable';
    if (!isValidContainerChannel(channel)) {
      logger.warn(
        { jid: row.jid, container_channel: channel },
        'Invalid container_channel value, falling back to stable',
      );
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: toIso(row.added_at) || '',
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      isAdmin: row.is_admin === 1 ? true : undefined,
      multiAgentRouter: row.multi_agent_router === 1 ? true : undefined,
      containerChannel: isValidContainerChannel(channel) ? channel : 'stable',
    };
  }
  return result;
}

/**
 * Delete a registered group by JID.
 */
export async function deleteRegisteredGroup(jid: string): Promise<void> {
  await sql`DELETE FROM registered_groups WHERE jid = ${jid}`;
}

/**
 * Relocate all tasks from one group to another.
 */
export async function relocateTasks(
  fromFolder: string,
  toFolder: string,
  toJid: string,
): Promise<number> {
  const result = await sql`
    UPDATE scheduled_tasks SET group_folder = ${toFolder}, chat_jid = ${toJid}
    WHERE group_folder = ${fromFolder}
  `;
  return result.count;
}

// --- JSON migration ---

async function migrateJsonState(): Promise<void> {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      await setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      await setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      await setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        await setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Delegation accessors ---

export interface DelegationRecord {
  uuid: string;
  caller_jid: string;
  target_jid: string;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'fulfilled' | 'expired';
}

export async function createDelegation(
  record: DelegationRecord,
): Promise<void> {
  await sql`
    INSERT INTO delegations (uuid, caller_jid, target_jid, created_at, expires_at, status)
    VALUES (${record.uuid}, ${record.caller_jid}, ${record.target_jid}, ${record.created_at}, ${record.expires_at}, ${record.status})
  `;
}

export async function getDelegationByUuid(
  uuid: string,
): Promise<DelegationRecord | undefined> {
  const rows = await sql`SELECT * FROM delegations WHERE uuid = ${uuid}`;
  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    uuid: r.uuid,
    caller_jid: r.caller_jid,
    target_jid: r.target_jid,
    created_at: toIso(r.created_at) || '',
    expires_at: toIso(r.expires_at) || '',
    status: r.status,
  };
}

export async function fulfillDelegation(uuid: string): Promise<void> {
  await sql`UPDATE delegations SET status = 'fulfilled' WHERE uuid = ${uuid}`;
}

// --- Error log ---

export interface ErrorLogEntry {
  level: 'error' | 'fatal' | 'warn';
  message: string;
  context?: Record<string, unknown>;
}

export async function logError(entry: ErrorLogEntry): Promise<void> {
  const contextJson = entry.context ? JSON.stringify(entry.context) : null;
  await sql`
    INSERT INTO error_log (level, message, context) VALUES (${entry.level}, ${entry.message}, ${contextJson})
  `;
}

/**
 * Test PostgreSQL connectivity. Returns true if a simple query succeeds.
 */
export async function testConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// --- DB maintenance ---

/**
 * Delete messages older than `retentionDays` days.
 */
export async function pruneOldMessages(
  retentionDays: number = 30,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await sql`DELETE FROM messages WHERE timestamp < ${cutoff}`;
  return result.count;
}

/**
 * Mark pending delegations past their expires_at as 'expired'.
 */
export async function expireStaleDelegations(): Promise<number> {
  const now = new Date().toISOString();
  const result = await sql`
    UPDATE delegations SET status = 'expired' WHERE status = 'pending' AND expires_at < ${now}
  `;
  return result.count;
}

// --- Transaction helper ---

/**
 * Run a function inside a PostgreSQL transaction (all-or-nothing).
 */
export async function runInTransaction(fn: () => Promise<void>): Promise<void> {
  await sql.begin(async () => {
    await fn();
  });
}

export async function getErrorLogs(
  limit: number = 100,
  level?: 'error' | 'fatal' | 'warn',
): Promise<
  Array<{
    id: number;
    level: string;
    message: string;
    context: string | null;
    timestamp: string;
  }>
> {
  let rows;
  if (level) {
    rows = await sql`
      SELECT id, level, message, context, timestamp FROM error_log
      WHERE level = ${level} ORDER BY timestamp DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT id, level, message, context, timestamp FROM error_log
      ORDER BY timestamp DESC LIMIT ${limit}
    `;
  }
  return rows.map((r) => ({
    id: Number(r.id),
    level: r.level,
    message: r.message,
    context: r.context,
    timestamp: toIso(r.timestamp) || '',
  }));
}

// --- Maintenance queries used by nightly maintenance ---

/**
 * Expire stale delegations — alias for backward compat with consumers.
 */
export { expireStaleDelegations as expireDelegations };

// --- Helper: map a raw task row to ScheduledTask ---

function mapTask(row: Record<string, any>): ScheduledTask {
  return {
    id: row.id,
    group_folder: row.group_folder,
    chat_jid: row.chat_jid,
    prompt: row.prompt,
    description: row.description ?? null,
    schedule_type: row.schedule_type,
    schedule_value: row.schedule_value,
    context_mode: row.context_mode || 'isolated',
    next_run: toIso(row.next_run),
    last_run: toIso(row.last_run),
    last_result: row.last_result ?? null,
    status: row.status,
    created_at: toIso(row.created_at) || '',
    script: row.script ?? null,
  };
}
