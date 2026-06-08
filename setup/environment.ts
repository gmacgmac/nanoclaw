/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import postgres from 'postgres';

import { DATABASE_URL } from '../src/config.js';
import { logger } from '../src/logger.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Check Apple Container
  let appleContainer: 'installed' | 'not_found' = 'not_found';
  if (commandExists('container')) {
    appleContainer = 'installed';
  }

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));
  const hasSecretsEnv = fs.existsSync(
    path.join(os.homedir(), '.config', 'nanoclaw', 'secrets.env'),
  );
  const hasMountAllowlist = fs.existsSync(
    path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json'),
  );
  const hasSenderAllowlist = fs.existsSync(
    path.join(os.homedir(), '.config', 'nanoclaw', 'sender-allowlist.json'),
  );

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  // Check DATABASE_URL and query registered groups from PostgreSQL.
  // Graceful — if DATABASE_URL is unset or PG is unreachable, reports false
  // without crashing. Setup step 2b handles getting PG running.
  const hasDatabaseUrl = Boolean(DATABASE_URL);
  let hasRegisteredGroups = false;

  if (hasDatabaseUrl) {
    let sql: postgres.Sql | null = null;
    try {
      sql = postgres(DATABASE_URL, {
        max: 1,
        connect_timeout: 3,
        idle_timeout: 5,
        max_lifetime: 10,
        onnotice: () => {},
      });
      const row = await sql`SELECT COUNT(*) as count FROM registered_groups`;
      hasRegisteredGroups = Number(row[0].count) > 0;
    } catch {
      // PG not yet running or schema not yet created — not an error at this stage
      hasRegisteredGroups = false;
    } finally {
      if (sql) {
        try {
          await sql.end({ timeout: 3 });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  logger.info(
    {
      platform,
      wsl,
      appleContainer,
      docker,
      hasEnv,
      hasSecretsEnv,
      hasMountAllowlist,
      hasSenderAllowlist,
      hasAuth,
      hasDatabaseUrl,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_SECRETS_ENV: hasSecretsEnv,
    HAS_MOUNT_ALLOWLIST: hasMountAllowlist,
    HAS_SENDER_ALLOWLIST: hasSenderAllowlist,
    HAS_AUTH: hasAuth,
    HAS_DATABASE_URL: hasDatabaseUrl,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
