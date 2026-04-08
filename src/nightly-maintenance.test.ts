import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  getNightlyFlushPrompt,
  NightlyDependencies,
  parseLastInputTokens,
  runNightlyMaintenance,
} from './nightly-maintenance.js';
import { RegisteredGroup } from './types.js';

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
    fs.writeFileSync(logPath, '[2026-04-07T10:00:00Z] id=msg_001 type=message output=500\n');
    expect(parseLastInputTokens(groupFolder)).toBe(0);
  });

  it('returns 0 for invalid group folder', () => {
    expect(parseLastInputTokens('../../escape')).toBe(0);
  });
});

// --- getNightlyFlushPrompt ---

describe('getNightlyFlushPrompt', () => {
  it('returns a string containing today\'s date and <internal> tags', () => {
    const prompt = getNightlyFlushPrompt();
    const today = new Date().toISOString().split('T')[0];
    expect(prompt).toContain('<internal>');
    expect(prompt).toContain('</internal>');
    expect(prompt).toContain(today);
    expect(prompt).toContain('MEMORY.md');
    expect(prompt).toContain('COMPACT.md');
  });
});

// --- runNightlyMaintenance ---

describe('runNightlyMaintenance', () => {
  const groupDir = path.join(GROUPS_DIR, 'maint-group');
  const logPath = path.join(groupDir, 'token-usage.log');

  const makeGroup = (folder: string, contextWindowSize?: number): RegisteredGroup => ({
    name: folder,
    folder,
    trigger: `@${folder}`,
    added_at: '2026-01-01T00:00:00Z',
    containerConfig: contextWindowSize ? { contextWindowSize } : undefined,
  });

  beforeEach(() => {
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.join(GROUPS_DIR, 'maint-group'), { recursive: true, force: true });
    // Clean up any other test group dirs
    for (const d of ['below-group', 'above-group', 'no-session-group']) {
      fs.rmSync(path.join(GROUPS_DIR, d), { recursive: true, force: true });
    }
  });

  it('flushes groups above 50% and clears session', async () => {
    // Group at 70% of 100k context window
    fs.writeFileSync(logPath, '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n');

    const runFlush = vi.fn().mockResolvedValue(true);
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(1);
    expect(result.groupsFlushed).toEqual(['maint-group']);
    expect(runFlush).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledWith('maint-group');
  });

  it('skips groups below 50% threshold', async () => {
    // Group at 30% of 128k default context window
    fs.mkdirSync(path.join(GROUPS_DIR, 'below-group'), { recursive: true });
    const belowLogPath = path.join(GROUPS_DIR, 'below-group', 'token-usage.log');
    fs.writeFileSync(belowLogPath, '[2026-04-07T10:00:00Z] id=msg_001 type=message input=38000 output=200\n');

    const runFlush = vi.fn();
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({ 'jid1@g.us': makeGroup('below-group') }),
      getSessions: () => ({ 'below-group': 'session-456' }),
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(1);
    expect(result.groupsFlushed).toEqual([]);
    expect(runFlush).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('skips groups without active sessions', async () => {
    const runFlush = vi.fn();
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group') }),
      getSessions: () => ({}), // No active sessions
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(0);
    expect(result.groupsFlushed).toEqual([]);
    expect(runFlush).not.toHaveBeenCalled();
  });

  it('does not clear session when flush fails', async () => {
    fs.writeFileSync(logPath, '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n');

    const runFlush = vi.fn().mockResolvedValue(false);
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsFlushed).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('handles flush errors gracefully without crashing', async () => {
    fs.writeFileSync(logPath, '[2026-04-07T10:00:00Z] id=msg_001 type=message input=70000 output=500\n');

    const runFlush = vi.fn().mockRejectedValue(new Error('container crashed'));
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({ 'jid1@g.us': makeGroup('maint-group', 100000) }),
      getSessions: () => ({ 'maint-group': 'session-123' }),
    };

    // Should not throw
    const result = await runNightlyMaintenance(deps);

    expect(result.groupsFlushed).toEqual([]);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('processes multiple groups independently', async () => {
    // above-group at 60% of 100k
    fs.mkdirSync(path.join(GROUPS_DIR, 'above-group'), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, 'above-group', 'token-usage.log'),
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=60000 output=500\n',
    );

    // below-group at 20% of 100k
    fs.mkdirSync(path.join(GROUPS_DIR, 'below-group'), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, 'below-group', 'token-usage.log'),
      '[2026-04-07T10:00:00Z] id=msg_001 type=message input=20000 output=200\n',
    );

    const runFlush = vi.fn().mockResolvedValue(true);
    const clearSession = vi.fn();

    const deps: NightlyDependencies = {
      runFlush,
      clearSession,
      getGroups: () => ({
        'jid1@g.us': makeGroup('above-group', 100000),
        'jid2@g.us': makeGroup('below-group', 100000),
      }),
      getSessions: () => ({
        'above-group': 'session-a',
        'below-group': 'session-b',
      }),
    };

    const result = await runNightlyMaintenance(deps);

    expect(result.groupsChecked).toBe(2);
    expect(result.groupsFlushed).toEqual(['above-group']);
    expect(runFlush).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledWith('above-group');
  });
});
