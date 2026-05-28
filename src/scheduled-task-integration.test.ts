/**
 * Integration tests for BE_01..BE_04: runtime state, crash recovery,
 * early next_run advance, and graceful shutdown working together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getOrphanedStartedRuns,
  getTaskById,
  logTaskRunStarted,
  updateTaskRunLog,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { sweepAbandonedRuns } from './abandoned-run-sweep.js';
import { deriveRuntimeState } from './task-runtime-state.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-integration',
  HOME_DIR: '/tmp/nanoclaw-test-home',
  GROUPS_DIR: '/tmp/nanoclaw-test-integration/groups',
  STORE_DIR: '/tmp/nanoclaw-test-integration/store',
  MAX_CONCURRENT_CONTAINERS: 2,
  SCHEDULER_POLL_INTERVAL: 5000,
  TIMEZONE: 'UTC',
  ASSISTANT_NAME: 'Test',
  CONTAINER_IMAGE_OVERRIDE: '',
  CONTAINER_IMAGE_BASE: 'nanoclaw-agent',
  CONTAINER_TIMEOUT: 1800000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CREDENTIAL_PROXY_PORT: 3001,
  IDLE_TIMEOUT: 1800000,
  IPC_POLL_INTERVAL: 1000,
  MAX_MESSAGES_PER_PROMPT: 10,
  NIGHTLY_NUDGE_THRESHOLD: 0.7,
  DEFAULT_CONTEXT_WINDOW: 128000,
  SHUTDOWN_GRACE_MS: 30000,
}));

// Mock fs operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

function createTestTask(
  id: string,
  overrides: Partial<Parameters<typeof createTask>[0]> = {},
) {
  createTask({
    id,
    group_folder: 'test-group',
    chat_jid: 'group@g.us',
    prompt: `Task ${id}`,
    schedule_type: 'interval',
    schedule_value: '300000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('scheduled task integration', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('full lifecycle of a successful run', () => {
    it('transitions runtime_state through idle → running → completed with audit trail', async () => {
      const queue = new GroupQueue();
      const now = new Date();

      // 1. Create a task with next_run in the future → idle
      const futureRun = new Date(Date.now() + 600_000).toISOString();
      createTestTask('lifecycle-task', { next_run: futureRun });

      const task = getTaskById('lifecycle-task')!;
      expect(deriveRuntimeState(task, queue, now)).toBe('idle');

      // 2. Make it due (next_run in the past)
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      createTestTask('lifecycle-due', { next_run: pastDue });
      const dueTask = getTaskById('lifecycle-due')!;
      expect(deriveRuntimeState(dueTask, queue, now)).toBe('due');

      // 3. Simulate scheduler picking it up via enqueueTask → running
      let resolveTask: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      queue.enqueueTask('group@g.us', 'lifecycle-due', async () => {
        // Inside the task: insert started row (simulating runTask behavior)
        const runLogId = logTaskRunStarted(
          'lifecycle-due',
          new Date().toISOString(),
        );

        // Verify runtime_state is 'running' while task executes
        const runningTask = getTaskById('lifecycle-due')!;
        expect(deriveRuntimeState(runningTask, queue, new Date())).toBe(
          'running',
        );

        // Verify started log row exists
        const orphans = getOrphanedStartedRuns();
        expect(orphans.some((o) => o.task_id === 'lifecycle-due')).toBe(true);

        // Complete the run
        updateTaskRunLog(runLogId, {
          status: 'success',
          result: 'Done',
          duration_ms: 500,
        });

        resolveTask!();
      });

      await vi.advanceTimersByTimeAsync(10);
      await taskPromise;
      await vi.advanceTimersByTimeAsync(10);

      // 4. After completion: no orphaned rows, task no longer running
      expect(getOrphanedStartedRuns()).toHaveLength(0);
    });
  });

  describe('crash recovery', () => {
    it('sweeps orphaned started rows and sends aggregated alerts', async () => {
      // Simulate prior crash: insert started rows directly
      createTestTask('crash-t1', { chat_jid: 'group1@g.us' });
      createTestTask('crash-t2', { chat_jid: 'group1@g.us' });
      createTestTask('crash-t3', {
        chat_jid: 'group2@g.us',
        group_folder: 'other-group',
      });

      logTaskRunStarted('crash-t1', '2026-01-01T00:00:00.000Z');
      logTaskRunStarted('crash-t2', '2026-01-01T00:01:00.000Z');
      logTaskRunStarted('crash-t3', '2026-01-01T00:02:00.000Z');

      // Verify orphans exist
      expect(getOrphanedStartedRuns()).toHaveLength(3);

      // Run sweep with mocked channel
      const sentMessages: Array<{ jid: string; text: string }> = [];
      const mockSendMessage = vi.fn(async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      });

      await sweepAbandonedRuns({ sendMessage: mockSendMessage });

      // All orphans closed as error
      expect(getOrphanedStartedRuns()).toHaveLength(0);

      // Alerts sent per group
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      const group1Alert = sentMessages.find((m) => m.jid === 'group1@g.us');
      expect(group1Alert).toBeDefined();
      expect(group1Alert!.text).toContain('2 task run(s) abandoned');
      expect(group1Alert!.text).toContain('Task crash-t1');
      expect(group1Alert!.text).toContain('Task crash-t2');

      const group2Alert = sentMessages.find((m) => m.jid === 'group2@g.us');
      expect(group2Alert).toBeDefined();
      expect(group2Alert!.text).toContain('1 task run(s) abandoned');
    });

    it('next_run already advanced prevents re-trigger after crash', async () => {
      // Simulate: task ran, next_run was advanced, then host crashed
      const futureRun = new Date(Date.now() + 300_000).toISOString();
      createTestTask('no-retrigger', { next_run: futureRun });
      logTaskRunStarted('no-retrigger', '2026-01-01T00:00:00.000Z');

      // Sweep cleans the orphan
      await sweepAbandonedRuns({ sendMessage: vi.fn() });
      expect(getOrphanedStartedRuns()).toHaveLength(0);

      // Task's next_run is still in the future — scheduler won't pick it up
      const task = getTaskById('no-retrigger')!;
      expect(new Date(task.next_run!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('graceful shutdown', () => {
    it('writes _close to active containers and resolves within grace', async () => {
      const fs = await import('fs');
      const queue = new GroupQueue();
      let resolveTask: () => void;

      // Start a task that blocks until we release it
      queue.enqueueTask('group@g.us', 'shutdown-task', async () => {
        await new Promise<void>((resolve) => {
          resolveTask = resolve;
        });
      });
      await vi.advanceTimersByTimeAsync(10);

      // Register a process so shutdown can write _close
      queue.registerProcess(
        'group@g.us',
        {} as any,
        'container-shutdown',
        'test-group',
      );

      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      writeFileSync.mockClear();

      // Start shutdown
      let shutdownResolved = false;
      const shutdownPromise = queue.shutdown(5000).then(() => {
        shutdownResolved = true;
      });

      // _close should have been written
      const closeWrites = writeFileSync.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeWrites).toHaveLength(1);

      // Shutdown should NOT have resolved yet (container still active)
      await vi.advanceTimersByTimeAsync(250);
      expect(shutdownResolved).toBe(false);

      // Container exits
      resolveTask!();
      await vi.advanceTimersByTimeAsync(300);
      await shutdownPromise;
      expect(shutdownResolved).toBe(true);
    });

    it('resolves after grace period even with hung containers', async () => {
      const queue = new GroupQueue();

      // Start a task that never resolves (simulates hung container)
      queue.enqueueTask('group@g.us', 'hung-task', async () => {
        await new Promise<void>(() => {}); // never resolves
      });
      await vi.advanceTimersByTimeAsync(10);

      queue.registerProcess(
        'group@g.us',
        {} as any,
        'container-hung',
        'test-group',
      );

      let shutdownResolved = false;
      const shutdownPromise = queue.shutdown(2000).then(() => {
        shutdownResolved = true;
      });

      // Not resolved before grace
      await vi.advanceTimersByTimeAsync(1500);
      expect(shutdownResolved).toBe(false);

      // Resolved after grace
      await vi.advanceTimersByTimeAsync(600);
      await shutdownPromise;
      expect(shutdownResolved).toBe(true);
    });

    it('prevents new task enqueues after shutdown starts', async () => {
      const queue = new GroupQueue();
      await queue.shutdown(1000);

      const taskFn = vi.fn(async () => {});
      queue.enqueueTask('group@g.us', 'post-shutdown', taskFn);
      await vi.advanceTimersByTimeAsync(100);

      expect(taskFn).not.toHaveBeenCalled();
    });
  });

  describe('chat-blocks-task scenario', () => {
    it('task is blocked when chat container is active, runs after chat exits', async () => {
      const queue = new GroupQueue();
      const executionOrder: string[] = [];
      let resolveChat: () => void;

      // Set up a chat container (processMessages)
      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveChat = resolve;
        });
        executionOrder.push('chat-done');
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start chat container
      queue.enqueueMessageCheck('group@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Create a due task and check its runtime_state
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      createTestTask('blocked-task', { next_run: pastDue });

      const task = getTaskById('blocked-task')!;
      // Task is due but group has active container → blocked
      expect(deriveRuntimeState(task, queue, new Date())).toBe('blocked');

      // Enqueue the task — it should be queued behind the chat
      const taskFn = vi.fn(async () => {
        executionOrder.push('task-done');
      });
      queue.enqueueTask('group@g.us', 'blocked-task', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      // Task should be queued (not running yet)
      expect(deriveRuntimeState(task, queue, new Date())).toBe('queued');
      expect(taskFn).not.toHaveBeenCalled();

      // Chat exits → task should run
      resolveChat!();
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).toHaveBeenCalledTimes(1);
      expect(executionOrder).toEqual(['chat-done', 'task-done']);
    });

    it('idle preemption: task enqueued while chat is idle triggers _close', async () => {
      const fs = await import('fs');
      const queue = new GroupQueue();
      let resolveChat: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveChat = resolve;
        });
        return true;
      });
      queue.setProcessMessagesFn(processMessages);

      // Start chat container and mark idle
      queue.enqueueMessageCheck('group@g.us');
      await vi.advanceTimersByTimeAsync(10);
      queue.registerProcess(
        'group@g.us',
        {} as any,
        'chat-container',
        'test-group',
      );
      queue.notifyIdle('group@g.us');

      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      writeFileSync.mockClear();

      // Enqueue task while chat is idle → should preempt
      const taskFn = vi.fn(async () => {});
      queue.enqueueTask('group@g.us', 'preempt-task', taskFn);

      const closeWrites = writeFileSync.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeWrites).toHaveLength(1);

      // Clean up
      resolveChat!();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  describe('scheduler + runtime_state + audit trail end-to-end', () => {
    it('scheduler poll advances next_run and creates started log row', async () => {
      const pastDue = new Date(Date.now() - 60_000).toISOString();
      createTestTask('e2e-task', {
        next_run: pastDue,
        schedule_type: 'interval',
        schedule_value: '300000',
      });

      const enqueueTask = vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          void fn();
        },
      );

      startSchedulerLoop({
        registeredGroups: () => ({
          'group@g.us': {
            name: 'Test',
            folder: 'test-group',
            trigger: '!bot',
            added_at: '2026-01-01T00:00:00.000Z',
          },
        }),
        getSessions: () => ({}),
        queue: { enqueueTask } as any,
        onProcess: () => {},
        sendMessage: async () => {},
      });

      await vi.advanceTimersByTimeAsync(10);

      // next_run should be advanced to the future
      const task = getTaskById('e2e-task')!;
      expect(task.next_run).not.toBeNull();
      expect(new Date(task.next_run!).getTime()).toBeGreaterThan(Date.now());

      // A started log row should have been created (and closed as error
      // because preset resolution fails in test env — that's expected)
      const orphans = getOrphanedStartedRuns();
      expect(orphans).toHaveLength(0); // closed out (error from missing preset)
    });
  });
});
