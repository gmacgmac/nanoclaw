/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Checks Docker/PG health, PostgreSQL connectivity, schema, and group count.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import postgres from 'postgres';

import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8', timeout: 5_000 });
      if (output.includes('com.nanoclaw')) {
        const line = output.split('\n').find((l) => l.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available or timed out
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore', timeout: 5_000 });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
          timeout: 5_000,
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available or timed out
      }
    }
  } else {
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore', timeout: 5_000 });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials (multi-vendor format in secrets.env, or legacy in .env)
  let credentials = 'missing';
  const secretsFile = path.join(homeDir, '.config', 'nanoclaw', 'secrets.env');
  const envFile = path.join(projectRoot, '.env');

  const checkCredentials = (filePath: string): boolean => {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (/^(?!ANTHROPIC_API_KEY)[A-Z]+_API_KEY=/m.test(content)) return true;
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=/m.test(content)) return true;
    return false;
  };

  if (checkCredentials(secretsFile)) {
    credentials = 'configured';
  } else if (checkCredentials(envFile)) {
    credentials = 'configured';
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
    'DATABASE_URL',
  ]);

  const channelAuth: Record<string, string> = {};

  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  if (process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN) {
    channelAuth.telegram = 'configured';
  }
  if (
    (process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
    (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)
  ) {
    channelAuth.slack = 'configured';
  }
  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. Docker and PG container health checks
  // Reuse the container-runtime check result to avoid calling `docker info` twice
  const dockerStatus = containerRuntime === 'docker' ? 'running' : 'not_found';
  let pgContainerStatus = 'not_found';

  if (dockerStatus === 'running') {
    try {
      const composePath = path.join(projectRoot, 'docker-compose.yml');
      const output = execSync(
        `docker compose -f "${composePath}" ps postgres --format json`,
        { encoding: 'utf-8', timeout: 10_000 },
      ).trim();
      if (output) {
        // docker compose v2 outputs JSON (one object per line or array)
        const firstLine = output.split('\n')[0];
        const info = JSON.parse(firstLine);
        const health = (info.Health || info.health || '').toLowerCase();
        const state = (info.State || info.state || '').toLowerCase();
        if (health === 'healthy' || state === 'running') {
          pgContainerStatus = health === 'healthy' ? 'healthy' : 'running';
        } else {
          pgContainerStatus = state || 'stopped';
        }
      }
    } catch {
      // Container may not exist, compose format unexpected, or timeout
      pgContainerStatus = 'not_found';
    }
  }

  // 6. DATABASE_URL and connectivity check
  const dbUrl = process.env.DATABASE_URL || envVars.DATABASE_URL || '';
  const databaseUrl = dbUrl ? 'configured' : 'missing';

  let pgConnection = 'skipped';
  let pgSchema = 'skipped';
  let registeredGroups = 0;
  let sql: postgres.Sql | null = null;

  if (databaseUrl === 'configured') {
    try {
      sql = postgres(dbUrl, {
        max: 1,
        connect_timeout: 3,
        idle_timeout: 5,
        max_lifetime: 10,
        onnotice: () => {},
      });
      await sql`SELECT 1`;
      pgConnection = 'ok';
    } catch {
      pgConnection = 'failed';
    }

    // 7. Verify schema tables
    if (pgConnection === 'ok' && sql) {
      try {
        const expectedTables = [
          'registered_groups',
          'messages',
          'sessions',
          'scheduled_tasks',
          'task_run_logs',
          'dashboard_chat_log',
        ];
        const rows = await sql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
        `;
        const existing = new Set(rows.map((r) => r.table_name));
        const missing = expectedTables.filter((t) => !existing.has(t));

        if (missing.length === 0) {
          pgSchema = 'ok';
        } else if (existing.size === 0) {
          pgSchema = 'empty';
        } else {
          pgSchema = `incomplete (missing: ${missing.join(', ')})`;
        }
      } catch {
        pgSchema = 'empty';
      }
    }

    // 8. Group count from PG
    if (pgConnection === 'ok' && sql) {
      try {
        const row = await sql`SELECT COUNT(*) as count FROM registered_groups`;
        registeredGroups = Number(row[0].count);
      } catch {
        registeredGroups = 0;
      }
    }
  }

  // 9. Cleanup PG connection (with timeout to avoid hanging if PG is unresponsive)
  if (sql) {
    try {
      await sql.end({ timeout: 3 });
    } catch {
      // Ignore cleanup errors — process is about to exit anyway
    }
  }

  // 10. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // 11. Check sender allowlist
  let senderAllowlist = 'missing';
  const senderAllowlistPath = path.join(
    homeDir,
    '.config',
    'nanoclaw',
    'sender-allowlist.json',
  );
  if (fs.existsSync(senderAllowlistPath)) {
    try {
      const content = fs.readFileSync(senderAllowlistPath, 'utf-8');
      const config = JSON.parse(content);
      if (config.default?.allow?.length > 0) {
        senderAllowlist = 'configured';
      }
    } catch {
      // Invalid JSON, treat as missing
    }
  }

  // Determine overall status
  const status =
    service === 'running' &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredGroups > 0 &&
    pgConnection === 'ok'
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    DOCKER: dockerStatus,
    PG_CONTAINER: pgContainerStatus,
    DATABASE_URL: databaseUrl,
    PG_CONNECTION: pgConnection,
    PG_SCHEMA: pgSchema,
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    SENDER_ALLOWLIST: senderAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
