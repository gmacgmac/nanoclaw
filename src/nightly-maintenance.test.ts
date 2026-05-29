import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  NightlyDependencies,
  parseLastInputTokens,
  pruneContainerLogs,
  rotateMainLogs,
  runNightlyMaintenance,
  truncateTokenUsageLogs,
} from './nightly-maintenance.js';
import { RegisteredGroup } from './types.js';

// Mock resolvePreset to return contextWindow from the preset name
vi.mock('./presets.js', () => ({
  resolvePreset: (name: string | undefined) => {
    if (!name) return null;
    // Preset name encodes context window for test purposes (e.g. "test-100k")
    const match = name.match(/^test-(\d+)k$/);
    if (match) {
      return {
        name,
        endpoint: 'anthropic',
        model: 'test-model',
        capabilities: { vision: false },
        contextWindow: parseInt(match[1], 10) * 1000,
        webSearchVendor: 'ollama',
      };
    }
    return null;
  },
}));

// --- parseLastInputTokens ---

describe('parseLastInputTokens', () => {
  const groupFolder = 'test-group';
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const logPath = path.join(groupDir, 'token-usage.log');

  beforeEach(() => {
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('returns 0 when token-usage.log does not exist', () => {
    expect(parseLastInputTokens(groupFolder)).toBe(0);
  });

  it('returns 0 for empty file', () => {
    fs.writeFileSync(logPath, '');
    expect(parseLastInputTokens(groupFolder)).toBe(0);
  });

  it('parses input tokens from the first line (newest entry)', () => {
    const content = [
      '[2026-04-07T10:00:00Z] id=msg_002 type=message input=75000 output=500',
      '[2026-04-07T09:00:00Z] id=msg_001 type=message input=30000 output=200',
    ].join('\n');
    fs.writeFileSync(logPath, content);
    expect(parseLastInputTokens(groupFolder)).toBe(75000);
  });

  it('returns 0 for malformed log line without input=', () => {
    fs.writeFileSync(
      logPath,
      '[2026-04-07T10:00:00Z] id=msg_001 type=message output=500\n',
    );
    expect(parseLastInputTokens(groupFolder)).toBe(0);
  });

  it('returns 0 for invalid group folder', () => {
    expect(parseLastInputTokens('../../escape')).toBe(0);
  });
});

// --- runNightlyMaintenance ---

describe('runNightlyMaintenance', () => {
  const groupDir = path.join(GROUPS_DIR, 'maint-group');
  const logPath = path.join(groupDir, 'token-usage.log');
  let tmpLogsDir: string;

  const makeGroup = (
    folder: string,
    contextWindowSize?: number,
  ): RegisteredGroup => ({
    name: folder,
    folder,
    trigger: `@${folder}`,
    added_at: '2026-01-01T00:00:00Z',
    containerConfig: contextWindowSize
      ? { preset: `test-${contextWindowSize / 1000}k` }
      : undefined,
  });

  beforeEach(() => {
    fs.mkdirSync(groupDir, { recursive: true });
    tmpLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-logs-'));
  });

  afterEach(() => {
    fs.rmSync(path.join(GROUPS_DIR, 'maint-group'), {
      recursive: true,
      force: true,
    });
    // Clean up any other test group dirs
    for (const d of ['below-group', 'above-group', 'no-session-group']) {
      fs.rmSync(path.join(GROUPS_DIR, d), { recursive: true, force: true });
    }
    fs.rmSync(tmpLogsDir, { recursive: true, force: true });
  });

  it('nudges groups above 50% without clearing session', async () => {
    // Group at 70% of 100k context window
    fs.writeFileSync(
      logPath,
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n',
    );

    const runNudge = vi.fn().mockResolvedValue(true);

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(1);
    expect(result.groupsNudged).toEqual(['maint-group']);
    expect(runNudge).toHaveBeenCalledOnce();
  });

  it('skips groups below 50% threshold', async () => {
    // Group at 30% of 128k default context window
    fs.mkdirSync(path.join(GROUPS_DIR, 'below-group'), { recursive: true });
    const belowLogPath = path.join(
      GROUPS_DIR,
      'below-group',
      'token-usage.log',
    );
    fs.writeFileSync(
      belowLogPath,
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=38000 output=200\n',
    );

    const runNudge = vi.fn();

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({ 'jid1@g.us': makeGroup('below-group') }),
      getSessions: () => ({ 'below-group': 'session-456' }),
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(1);
    expect(result.groupsNudged).toEqual([]);
    expect(runNudge).not.toHaveBeenCalled();
  });

  it('skips groups without active sessions', async () => {
    const runNudge = vi.fn();

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group') }),
      getSessions: () => ({}), // No active sessions
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(0);
    expect(result.groupsNudged).toEqual([]);
    expect(runNudge).not.toHaveBeenCalled();
  });

  it('does not record group when nudge returns false', async () => {
    fs.writeFileSync(
      logPath,
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n',
    );

    const runNudge = vi.fn().mockResolvedValue(false);

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsNudged).toEqual([]);
  });

  it('handles nudge errors gracefully without crashing', async () => {
    fs.writeFileSync(
      logPath,
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n',
    );

    const runNudge = vi.fn().mockRejectedValue(new Error('container crashed'));

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    // Should not throw
    const result = await runNightlyMaintenance(deps);

    expect(result.groupsNudged).toEqual([]);
  });

  it('processes multiple groups independently', async () => {
    // above-group at 80% of 100k
    fs.mkdirSync(path.join(GROUPS_DIR, 'above-group'), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, 'above-group', 'token-usage.log'),
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=80000 output=500\n',
    );

    // below-group at 20% of 100k
    fs.mkdirSync(path.join(GROUPS_DIR, 'below-group'), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, 'below-group', 'token-usage.log'),
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=20000 output=200\n',
    );

    const runNudge = vi.fn().mockResolvedValue(true);

    const deps: NightlyDependencies = {
      runNudge,
      getGroups: () => ({
        'jid1@g.us': makeGroup('above-group', 100000),
        'jid2@g.us': makeGroup('below-group', 100000),
      }),
      getSessions: () => ({
        'above-group': 'session-a',
        'below-group': 'session-b',
      }),
      pruneMessages: () => 0,
      expireDelegations: () => 0,
      logsDir: tmpLogsDir,
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(2);
    expect(result.groupsNudged).toEqual(['above-group']);
    expect(runNudge).toHaveBeenCalledOnce();
  });
});


// --- rotateMainLogs ---

describe('rotateMainLogs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-logs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies log to dated file and truncates original', () => {
    fs.writeFileSync(path.join(tmpDir, 'nanoclaw.log'), 'line1\nline2\n');
    fs.writeFileSync(path.join(tmpDir, 'nanoclaw.error.log'), 'err1\n');

    const result = rotateMainLogs(tmpDir);

    expect(result.rotated).toHaveLength(2);
    expect(result.rotated[0]).toMatch(/^nanoclaw-\d{4}-\d{2}-\d{2}\.log$/);
    expect(result.rotated[1]).toMatch(
      /^nanoclaw\.error-\d{4}-\d{2}-\d{2}\.log$/,
    );

    // Original should be truncated to 0
    expect(fs.readFileSync(path.join(tmpDir, 'nanoclaw.log'), 'utf-8')).toBe(
      '',
    );
    expect(
      fs.readFileSync(path.join(tmpDir, 'nanoclaw.error.log'), 'utf-8'),
    ).toBe('');

    // Dated copy should have original content
    const rotatedPath = path.join(tmpDir, result.rotated[0]);
    expect(fs.readFileSync(rotatedPath, 'utf-8')).toBe('line1\nline2\n');
  });

  it('skips empty log files', () => {
    fs.writeFileSync(path.join(tmpDir, 'nanoclaw.log'), '');

    const result = rotateMainLogs(tmpDir);

    expect(result.rotated).toHaveLength(0);
  });

  it('is idempotent — skips if already rotated today', () => {
    fs.writeFileSync(path.join(tmpDir, 'nanoclaw.log'), 'content\n');

    const first = rotateMainLogs(tmpDir);
    expect(first.rotated).toHaveLength(1);

    // Write more content to the (now empty) log
    fs.writeFileSync(path.join(tmpDir, 'nanoclaw.log'), 'new content\n');

    const second = rotateMainLogs(tmpDir);
    expect(second.rotated).toHaveLength(0); // Already rotated today
  });

  it('prunes rotated files older than 30 days', () => {
    // Create an old rotated file (40 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 40);
    const oldName = `nanoclaw-${oldDate.toISOString().slice(0, 10)}.log`;
    fs.writeFileSync(path.join(tmpDir, oldName), 'old content');

    // Create a recent rotated file (5 days ago)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    const recentName = `nanoclaw-${recentDate.toISOString().slice(0, 10)}.log`;
    fs.writeFileSync(path.join(tmpDir, recentName), 'recent content');

    const result = rotateMainLogs(tmpDir);

    expect(result.pruned).toContain(oldName);
    expect(result.pruned).not.toContain(recentName);
    expect(fs.existsSync(path.join(tmpDir, oldName))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, recentName))).toBe(true);
  });

  it('returns empty result for non-existent directory', () => {
    const result = rotateMainLogs('/tmp/does-not-exist-xyz');
    expect(result.rotated).toHaveLength(0);
    expect(result.pruned).toHaveLength(0);
  });
});

// --- pruneContainerLogs ---

describe('pruneContainerLogs', () => {
  const groupFolder = 'prune-test-group';
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const logsDir = path.join(groupDir, 'logs');

  beforeEach(() => {
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('deletes container logs older than 30 days', () => {
    // Old log (40 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 40);
    const oldTs = oldDate.toISOString().replace(/[:.]/g, '-');
    const oldFile = `container-${oldTs}.log`;
    fs.writeFileSync(path.join(logsDir, oldFile), 'old');

    // Recent log (2 days ago)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 2);
    const recentTs = recentDate.toISOString().replace(/[:.]/g, '-');
    const recentFile = `container-${recentTs}.log`;
    fs.writeFileSync(path.join(logsDir, recentFile), 'recent');

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const pruned = pruneContainerLogs(groups);

    expect(pruned).toBe(1);
    expect(fs.existsSync(path.join(logsDir, oldFile))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, recentFile))).toBe(true);
  });

  it('ignores non-matching filenames', () => {
    fs.writeFileSync(path.join(logsDir, 'random-file.txt'), 'data');
    fs.writeFileSync(path.join(logsDir, 'container-invalid.log'), 'data');

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const pruned = pruneContainerLogs(groups);
    expect(pruned).toBe(0);
  });

  it('handles groups with no logs directory', () => {
    fs.rmSync(logsDir, { recursive: true, force: true });

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const pruned = pruneContainerLogs(groups);
    expect(pruned).toBe(0);
  });
});

// --- truncateTokenUsageLogs ---

describe('truncateTokenUsageLogs', () => {
  const groupFolder = 'truncate-test-group';
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const logPath = path.join(groupDir, 'token-usage.log');

  beforeEach(() => {
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('truncates file to 100 lines when it exceeds that', () => {
    // Create 150 lines
    const lines = Array.from(
      { length: 150 },
      (_, i) =>
        `[2026-05-${String(29 - Math.floor(i / 10)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z] id=msg_${String(i).padStart(3, '0')} type=message input=${50000 + i} output=500`,
    );
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const trimmed = truncateTokenUsageLogs(groups);

    expect(trimmed).toBe(1);

    // Verify only 100 content lines remain
    const remaining = fs.readFileSync(logPath, 'utf-8');
    const remainingLines = remaining.split('\n').filter((l) => l.trim());
    expect(remainingLines).toHaveLength(100);

    // First line should be preserved (newest)
    expect(remainingLines[0]).toContain('msg_000');
  });

  it('does not modify file with exactly 100 lines', () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) =>
        `[2026-05-29T${String(i % 24).padStart(2, '0')}:00:00Z] id=msg_${String(i).padStart(3, '0')} type=message input=${50000 + i} output=500`,
    );
    const content = lines.join('\n') + '\n';
    fs.writeFileSync(logPath, content);

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const trimmed = truncateTokenUsageLogs(groups);
    expect(trimmed).toBe(0);

    // Content unchanged
    expect(fs.readFileSync(logPath, 'utf-8')).toBe(content);
  });

  it('does not modify file with fewer than 100 lines', () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) =>
        `[2026-05-29T${String(i).padStart(2, '0')}:00:00Z] id=msg_${String(i).padStart(3, '0')} type=message input=50000 output=500`,
    );
    const content = lines.join('\n') + '\n';
    fs.writeFileSync(logPath, content);

    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const trimmed = truncateTokenUsageLogs(groups);
    expect(trimmed).toBe(0);
  });

  it('handles missing token-usage.log gracefully', () => {
    const groups: Record<string, RegisteredGroup> = {
      'jid@g.us': {
        name: groupFolder,
        folder: groupFolder,
        trigger: '@test',
        added_at: '2026-01-01T00:00:00Z',
      },
    };

    const trimmed = truncateTokenUsageLogs(groups);
    expect(trimmed).toBe(0);
  });
});
