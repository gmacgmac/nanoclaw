import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getOrphanedStartedRuns,
  logTaskRunStarted,
  updateTaskRunLog,
} from './db.js';
import { sweepAbandonedRuns } from './abandoned-run-sweep.js';

beforeEach(() => {
  _initTestDatabase();
});

function createTestTask(id: string, groupFolder: string, chatJid: string) {
  createTask({
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: `Task ${id}`,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: '2026-01-01T00:00:00.000Z',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  });
}

describe('logTaskRunStarted', () => {
  it('returns a numeric row id', () => {
    createTestTask('t1', 'main', 'group@g.us');
    const id = logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('creates a row with status started', () => {
    createTestTask('t1', 'main', 'group@g.us');
    logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    const orphans = getOrphanedStartedRuns();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].task_id).toBe('t1');
  });
});

describe('updateTaskRunLog', () => {
  it('transitions a started row to success', () => {
    createTestTask('t1', 'main', 'group@g.us');
    const rowId = logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    updateTaskRunLog(rowId, {
      status: 'success',
      result: 'done',
      duration_ms: 1500,
    });
    // No longer orphaned
    const orphans = getOrphanedStartedRuns();
    expect(orphans).toHaveLength(0);
  });

  it('transitions a started row to error', () => {
    createTestTask('t1', 'main', 'group@g.us');
    const rowId = logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    updateTaskRunLog(rowId, {
      status: 'error',
      error: 'something broke',
      duration_ms: 200,
    });
    const orphans = getOrphanedStartedRuns();
    expect(orphans).toHaveLength(0);
  });
});

describe('getOrphanedStartedRuns', () => {
  it('returns only rows with status started', () => {
    createTestTask('t1', 'main', 'group@g.us');
    createTestTask('t2', 'main', 'group@g.us');

    const id1 = logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    logTaskRunStarted('t2', '2026-01-01T00:01:00.000Z');

    // Complete t1
    updateTaskRunLog(id1, { status: 'success', duration_ms: 100 });

    const orphans = getOrphanedStartedRuns();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].task_id).toBe('t2');
  });

  it('returns empty when no orphans exist', () => {
    const orphans = getOrphanedStartedRuns();
    expect(orphans).toHaveLength(0);
  });
});

describe('sweepAbandonedRuns', () => {
  it('closes orphaned runs and sends aggregated alerts', async () => {
    createTestTask('t1', 'main', 'group1@g.us');
    createTestTask('t2', 'main', 'group1@g.us');
    createTestTask('t3', 'other', 'group2@g.us');

    logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    logTaskRunStarted('t2', '2026-01-01T00:01:00.000Z');
    logTaskRunStarted('t3', '2026-01-01T00:02:00.000Z');

    const sentMessages: Array<{ jid: string; text: string }> = [];
    const mockSendMessage = vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
    });

    await sweepAbandonedRuns({ sendMessage: mockSendMessage });

    // All orphans closed
    expect(getOrphanedStartedRuns()).toHaveLength(0);

    // Two groups notified
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    const group1Alert = sentMessages.find((m) => m.jid === 'group1@g.us');
    expect(group1Alert).toBeDefined();
    expect(group1Alert!.text).toContain('2 task run(s) abandoned');
    expect(group1Alert!.text).toContain('Task t1');
    expect(group1Alert!.text).toContain('Task t2');

    const group2Alert = sentMessages.find((m) => m.jid === 'group2@g.us');
    expect(group2Alert).toBeDefined();
    expect(group2Alert!.text).toContain('1 task run(s) abandoned');
  });

  it('does nothing when no orphans exist', async () => {
    const mockSendMessage = vi.fn();
    await sweepAbandonedRuns({ sendMessage: mockSendMessage });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('continues even if sendMessage fails for one group', async () => {
    createTestTask('t1', 'main', 'group1@g.us');
    createTestTask('t2', 'other', 'group2@g.us');

    logTaskRunStarted('t1', '2026-01-01T00:00:00.000Z');
    logTaskRunStarted('t2', '2026-01-01T00:01:00.000Z');

    let callCount = 0;
    const mockSendMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network error');
    });

    await sweepAbandonedRuns({ sendMessage: mockSendMessage });

    // Both orphans still closed despite send failure
    expect(getOrphanedStartedRuns()).toHaveLength(0);
    // Both groups attempted
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
