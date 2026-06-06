#!/usr/bin/env tsx
/**
 * One-time migration script: SQLite → PostgreSQL
 *
 * Transfers all data from the existing SQLite database (store/messages.db)
 * to PostgreSQL, including TEXT→TIMESTAMPTZ conversion and SERIAL sequence alignment.
 *
 * Usage:
 *   tsx scripts/migrate-sqlite-to-postgres.ts
 *
 * Environment:
 *   SQLITE_PATH   — path to SQLite file (default: store/messages.db)
 *   DATABASE_URL  — PostgreSQL connection string (required)
 *
 * Requirements:
 *   - PG schema must already exist (run the app once with USE_POSTGRES=true, or initDatabase())
 *   - SQLite file must be readable
 *
 * Behavior:
 *   - Idempotent: uses ON CONFLICT DO NOTHING
 *   - Non-destructive: SQLite file is not modified
 *   - Transactional: all-or-nothing in PG
 */

import Database from 'better-sqlite3';
import postgres from 'postgres';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SQLITE_PATH = process.env.SQLITE_PATH || path.resolve(process.cwd(), 'store', 'messages.db');
const DATABASE_URL = process.env.DATABASE_URL || '';
const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidTimestamp(val: unknown): val is string {
  if (typeof val !== 'string' || val.trim() === '') return false;
  try {
    const d = new Date(val);
    // Verify it produces a valid ISO string (catches "Invalid Date")
    d.toISOString();
    return true;
  } catch {
    return false;
  }
}

/** Sanitize a timestamp value: valid ISO → as-is, otherwise null (with warning). */
function sanitizeTimestamp(val: unknown, table: string, column: string, warnings: string[]): string | null {
  if (val === null || val === undefined) return null;
  if (isValidTimestamp(val)) return val;
  warnings.push(`[${table}.${column}] Invalid timestamp "${String(val)}" → NULL`);
  return null;
}

// ---------------------------------------------------------------------------
// Table migration definitions
// ---------------------------------------------------------------------------

interface TableMigration {
  name: string;
  /** Column list to SELECT from SQLite */
  columns: string[];
  /** Columns that contain timestamps needing validation */
  timestampColumns: string[];
  /** PG conflict target for ON CONFLICT DO NOTHING */
  conflictTarget: string;
}

const TABLES: TableMigration[] = [
  {
    name: 'chats',
    columns: ['jid', 'name', 'last_message_time', 'channel', 'is_group'],
    timestampColumns: ['last_message_time'],
    conflictTarget: '(jid)',
  },
  {
    name: 'registered_groups',
    columns: [
      'jid', 'name', 'folder', 'trigger_pattern', 'added_at',
      'container_config', 'requires_trigger', 'is_main', 'is_admin',
      'multi_agent_router', 'container_channel',
    ],
    timestampColumns: ['added_at'],
    conflictTarget: '(jid)',
  },
  {
    name: 'sessions',
    columns: ['group_folder', 'session_id'],
    timestampColumns: [],
    conflictTarget: '(group_folder)',
  },
  {
    name: 'router_state',
    columns: ['key', 'value'],
    timestampColumns: [],
    conflictTarget: '(key)',
  },
  {
    name: 'messages',
    columns: ['id', 'chat_jid', 'sender', 'sender_name', 'content', 'timestamp', 'is_from_me', 'is_bot_message'],
    timestampColumns: ['timestamp'],
    conflictTarget: '(id, chat_jid)',
  },
  {
    name: 'scheduled_tasks',
    columns: [
      'id', 'group_folder', 'chat_jid', 'prompt', 'schedule_type',
      'schedule_value', 'next_run', 'last_run', 'last_result', 'status',
      'created_at', 'context_mode', 'script', 'description',
    ],
    timestampColumns: ['next_run', 'last_run', 'created_at'],
    conflictTarget: '(id)',
  },
  {
    name: 'task_run_logs',
    columns: ['id', 'task_id', 'run_at', 'duration_ms', 'status', 'result', 'error'],
    timestampColumns: ['run_at'],
    conflictTarget: '(id)',
  },
  {
    name: 'delegations',
    columns: ['uuid', 'caller_jid', 'target_jid', 'created_at', 'expires_at', 'status'],
    timestampColumns: ['created_at', 'expires_at'],
    conflictTarget: '(uuid)',
  },
  {
    name: 'error_log',
    columns: ['id', 'level', 'message', 'context', 'timestamp'],
    timestampColumns: ['timestamp'],
    conflictTarget: '(id)',
  },
  {
    name: 'dashboard_chat_log',
    columns: ['id', 'chat_jid', 'sender', 'sender_name', 'content', 'timestamp', 'is_from_user'],
    timestampColumns: ['timestamp'],
    conflictTarget: '(id)',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();
  const warnings: string[] = [];

  // --- Validate inputs ---
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`ERROR: SQLite file not found at "${SQLITE_PATH}".`);
    process.exit(1);
  }

  // --- Connect to SQLite (read-only) ---
  console.log(`[sqlite] Opening: ${SQLITE_PATH}`);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  // --- Connect to PostgreSQL ---
  console.log(`[pg] Connecting to PostgreSQL...`);
  const sql = postgres(DATABASE_URL, { max: 5, connect_timeout: 10 });

  // Verify PG connection
  try {
    await sql`SELECT 1`;
    console.log(`[pg] Connected.`);
  } catch (err) {
    console.error(`ERROR: Cannot connect to PostgreSQL: ${err instanceof Error ? err.message : err}`);
    sqlite.close();
    await sql.end();
    process.exit(1);
  }

  // --- Discover which tables exist in SQLite ---
  const existingTables = new Set<string>(
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name),
  );

  // --- Run migration inside a PG transaction ---
  try {
    await sql.begin(async (tx) => {
      for (const table of TABLES) {
        if (!existingTables.has(table.name)) {
          console.log(`[skip] Table "${table.name}" not found in SQLite — skipping.`);
          continue;
        }

        // Determine which columns actually exist in this SQLite table
        const sqliteColumns = sqlite
          .prepare(`PRAGMA table_info("${table.name}")`)
          .all()
          .map((r) => (r as { name: string }).name);
        const sqliteColumnSet = new Set(sqliteColumns);

        // Only select columns that exist in both the migration definition and SQLite
        const selectColumns = table.columns.filter((c) => sqliteColumnSet.has(c));
        if (selectColumns.length === 0) {
          console.log(`[skip] Table "${table.name}" has no matching columns — skipping.`);
          continue;
        }

        // Read all rows from SQLite
        let rows = sqlite
          .prepare(`SELECT ${selectColumns.map((c) => `"${c}"`).join(', ')} FROM "${table.name}"`)
          .all() as Record<string, unknown>[];

        // Filter orphaned FK rows (SQLite doesn't enforce FKs by default)
        if (table.name === 'task_run_logs') {
          const validTaskIds = new Set<string>(
            sqlite
              .prepare(`SELECT id FROM scheduled_tasks`)
              .all()
              .map((r) => (r as { id: string }).id),
          );
          const before = rows.length;
          rows = rows.filter((r) => validTaskIds.has(r.task_id as string));
          if (rows.length < before) {
            warnings.push(
              `[task_run_logs] Skipped ${before - rows.length} orphaned rows (missing parent task)`,
            );
          }
        }

        if (table.name === 'messages' || table.name === 'dashboard_chat_log') {
          const validJids = new Set<string>(
            sqlite
              .prepare(`SELECT jid FROM chats`)
              .all()
              .map((r) => (r as { jid: string }).jid),
          );
          const before = rows.length;
          rows = rows.filter((r) => validJids.has(r.chat_jid as string));
          if (rows.length < before) {
            warnings.push(
              `[${table.name}] Skipped ${before - rows.length} orphaned rows (missing parent chat)`,
            );
          }
        }

        if (rows.length === 0) {
          console.log(`[migrate] ${table.name}: 0 rows (empty)`);
          continue;
        }

        // Sanitize timestamp columns
        const sanitizedRows = rows.map((row) => {
          const newRow: Record<string, unknown> = {};
          for (const col of selectColumns) {
            if (table.timestampColumns.includes(col)) {
              newRow[col] = sanitizeTimestamp(row[col], table.name, col, warnings);
            } else {
              newRow[col] = row[col] ?? null;
            }
          }
          return newRow;
        });

        // Insert in chunks with ON CONFLICT DO NOTHING
        let inserted = 0;
        for (let i = 0; i < sanitizedRows.length; i += CHUNK_SIZE) {
          const chunk = sanitizedRows.slice(i, i + CHUNK_SIZE);
          const result = await tx`
            INSERT INTO ${sql(table.name)} ${sql(chunk, ...selectColumns)}
            ON CONFLICT ${sql.unsafe(table.conflictTarget)} DO NOTHING
          `;
          inserted += result.count;
        }

        console.log(`[migrate] ${table.name}: ${rows.length} rows read, ${inserted} inserted`);
      }

      // --- Advance SERIAL sequences ---
      console.log(`[sequence] Aligning SERIAL sequences...`);

      await tx`SELECT setval('task_run_logs_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM task_run_logs), 1))`;
      await tx`SELECT setval('error_log_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM error_log), 1))`;

      console.log(`[sequence] Done.`);
    });

    // --- Summary ---
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✓ Migration complete in ${elapsed}s`);

    if (warnings.length > 0) {
      console.log(`\n⚠ ${warnings.length} warning(s):`);
      for (const w of warnings) {
        console.log(`  ${w}`);
      }
    }
  } catch (err) {
    console.error(`\n✗ Migration FAILED — transaction rolled back.`);
    console.error(err instanceof Error ? err.message : err);
    sqlite.close();
    await sql.end();
    process.exit(1);
  }

  // --- Cleanup ---
  sqlite.close();
  await sql.end();
}

main();
