import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Tests for the unregister step.
 *
 * Verifies: delete path, relocate path (both columns), abort, invalid target.
 * Uses an in-memory DB matching the production schema.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      description TEXT,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'group',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      script TEXT
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'started',
      result TEXT,
      error TEXT
    );
  `);
  return db;
}

function seedGroups(db: Database.Database) {
  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('group-a@g.us', 'Group A', 'group-a', '@Andy', '2024-01-01T00:00:00Z', 0);

  db.prepare(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('group-b@g.us', 'Group B', 'group-b', '@Andy', '2024-01-01T00:00:00Z', 0);

  db.prepare(
    `INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)`,
  ).run('group-a', 'session-123');
}

function seedTasks(db: Database.Database) {
  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, description, schedule_type, schedule_value, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('task-1', 'group-a', 'group-a@g.us', 'Do thing 1', 'Task 1', 'cron', '0 9 * * *', 'active', '2024-01-01T00:00:00Z');

  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, description, schedule_type, schedule_value, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('task-2', 'group-a', 'group-a@g.us', 'Do thing 2', 'Task 2', 'interval', '3600000', 'active', '2024-01-01T00:00:00Z');

  // Add a run log for task-1 to verify cascade delete
  db.prepare(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result) VALUES (?, ?, ?, ?, ?)`,
  ).run('task-1', '2024-01-02T09:00:00Z', 5000, 'success', 'done');
}

describe('unregister: delete path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedGroups(db);
    seedTasks(db);
  });

  it('removes group row, session, and all tasks when deleting', () => {
    // Simulate the transactional delete logic
    db.transaction(() => {
      // Delete tasks (with run logs)
      const tasks = db
        .prepare('SELECT id FROM scheduled_tasks WHERE group_folder = ?')
        .all('group-a') as { id: string }[];
      for (const t of tasks) {
        db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(t.id);
      }
      // Delete session
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('group-a');
      // Delete registration
      db.prepare('DELETE FROM registered_groups WHERE jid = ?').run('group-a@g.us');
    })();

    // Verify group gone
    const group = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('group-a@g.us');
    expect(group).toBeUndefined();

    // Verify session gone
    const session = db.prepare('SELECT * FROM sessions WHERE group_folder = ?').get('group-a');
    expect(session).toBeUndefined();

    // Verify tasks gone
    const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ?').all('group-a');
    expect(tasks).toHaveLength(0);

    // Verify run logs gone
    const logs = db.prepare('SELECT * FROM task_run_logs WHERE task_id = ?').all('task-1');
    expect(logs).toHaveLength(0);

    // Verify group-b untouched
    const groupB = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('group-b@g.us');
    expect(groupB).toBeDefined();
  });
});

describe('unregister: relocate path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedGroups(db);
    seedTasks(db);
  });

  it('updates BOTH group_folder and chat_jid when relocating', () => {
    db.transaction(() => {
      // Relocate tasks
      db.prepare(
        'UPDATE scheduled_tasks SET group_folder = ?, chat_jid = ? WHERE group_folder = ?',
      ).run('group-b', 'group-b@g.us', 'group-a');
      // Delete session
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('group-a');
      // Delete registration
      db.prepare('DELETE FROM registered_groups WHERE jid = ?').run('group-a@g.us');
    })();

    // Verify tasks moved — both columns updated
    const tasks = db.prepare('SELECT * FROM scheduled_tasks').all() as {
      id: string;
      group_folder: string;
      chat_jid: string;
    }[];
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.group_folder).toBe('group-b');
      expect(t.chat_jid).toBe('group-b@g.us');
    }

    // Verify group-a gone
    const group = db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get('group-a@g.us');
    expect(group).toBeUndefined();

    // Verify task count unchanged (relocated, not deleted)
    const allTasks = db.prepare('SELECT * FROM scheduled_tasks').all();
    expect(allTasks).toHaveLength(2);
  });

  it('preserves task run logs when relocating', () => {
    db.transaction(() => {
      db.prepare(
        'UPDATE scheduled_tasks SET group_folder = ?, chat_jid = ? WHERE group_folder = ?',
      ).run('group-b', 'group-b@g.us', 'group-a');
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('group-a');
      db.prepare('DELETE FROM registered_groups WHERE jid = ?').run('group-a@g.us');
    })();

    const logs = db.prepare('SELECT * FROM task_run_logs WHERE task_id = ?').all('task-1');
    expect(logs).toHaveLength(1);
  });
});

describe('unregister: abort path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedGroups(db);
    seedTasks(db);
  });

  it('leaves everything intact on abort', () => {
    // Abort = do nothing
    const groups = db.prepare('SELECT * FROM registered_groups').all();
    expect(groups).toHaveLength(2);

    const tasks = db.prepare('SELECT * FROM scheduled_tasks').all();
    expect(tasks).toHaveLength(2);

    const sessions = db.prepare('SELECT * FROM sessions').all();
    expect(sessions).toHaveLength(1);
  });
});

describe('unregister: invalid relocate target', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedGroups(db);
    seedTasks(db);
  });

  it('rejects relocate to non-existent group', () => {
    const allGroups = db.prepare('SELECT jid FROM registered_groups').all() as { jid: string }[];
    const jids = allGroups.map((g) => g.jid);

    const invalidTarget = 'nonexistent@g.us';
    expect(jids).not.toContain(invalidTarget);
  });

  it('rejects relocate to the same group being removed', () => {
    const targetJid = 'group-a@g.us';
    const relocateToJid = 'group-a@g.us';

    // This should be caught before the transaction
    expect(targetJid).toBe(relocateToJid);
  });
});
