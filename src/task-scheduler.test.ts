import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  substitutePromptVars,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  describe('substitutePromptVars', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-04-29T20:05:00'));
    });

    it('replaces {{NOW}} with human-readable date and time', () => {
      expect(substitutePromptVars('Summary for {{NOW}}')).toBe(
        'Summary for Wednesday, 2026-04-29 20:05:00',
      );
    });

    it('replaces {{DATETIME}} with ISO-like string', () => {
      expect(substitutePromptVars('Run at {{DATETIME}}')).toBe(
        'Run at 2026-04-29T20:05:00',
      );
    });

    it('replaces {{DATE}} with YYYY-MM-DD', () => {
      expect(substitutePromptVars('Report for {{DATE}}')).toBe(
        'Report for 2026-04-29',
      );
    });

    it('replaces {{TIME}} with HH:MM:SS', () => {
      expect(substitutePromptVars('Check at {{TIME}}')).toBe(
        'Check at 20:05:00',
      );
    });

    it('replaces {{DAY_OF_WEEK}} with full weekday name', () => {
      expect(substitutePromptVars('Happy {{DAY_OF_WEEK}}!')).toBe(
        'Happy Wednesday!',
      );
    });

    it('replaces multiple occurrences of the same placeholder', () => {
      expect(substitutePromptVars('{{DATE}} and again {{DATE}}')).toBe(
        '2026-04-29 and again 2026-04-29',
      );
    });

    it('replaces multiple different placeholders', () => {
      expect(substitutePromptVars('{{DAY_OF_WEEK}} {{DATE}} {{TIME}}')).toBe(
        'Wednesday 2026-04-29 20:05:00',
      );
    });

    it('leaves unknown placeholders untouched', () => {
      expect(substitutePromptVars('{{UNKNOWN}} stays')).toBe(
        '{{UNKNOWN}} stays',
      );
    });

    it('returns prompt unchanged when no placeholders exist', () => {
      expect(substitutePromptVars('No placeholders here')).toBe(
        'No placeholders here',
      );
    });
  });
});
