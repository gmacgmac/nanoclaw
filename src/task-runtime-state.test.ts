import { describe, expect, it } from 'vitest';

import { GroupQueue } from './group-queue.js';
import { deriveRuntimeState } from './task-runtime-state.js';
import { ScheduledTask } from './types.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'test-group',
    chat_jid: 'test@jid',
    prompt: 'do something',
    description: 'Test task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60_000).toISOString(), // future by default
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    script: null,
    ...overrides,
  };
}

describe('deriveRuntimeState', () => {
  it('returns null for paused tasks', () => {
    const queue = new GroupQueue();
    const task = makeTask({ status: 'paused' });
    expect(deriveRuntimeState(task, queue, new Date())).toBe(null);
  });

  it('returns null for completed tasks', () => {
    const queue = new GroupQueue();
    const task = makeTask({ status: 'completed' });
    expect(deriveRuntimeState(task, queue, new Date())).toBe(null);
  });

  it('returns "idle" for active tasks with next_run in the future', () => {
    const queue = new GroupQueue();
    const task = makeTask({
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(deriveRuntimeState(task, queue, new Date())).toBe('idle');
  });

  it('returns "due" for active tasks with next_run in the past and no active container', () => {
    const queue = new GroupQueue();
    const task = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(deriveRuntimeState(task, queue, new Date())).toBe('due');
  });

  it('returns "blocked" for active tasks with next_run in the past and an active container', () => {
    const queue = new GroupQueue();
    // Trigger an active container by enqueueing a message check
    // We need to set up processMessagesFn to make the container "active"
    // Instead, use enqueueTask which sets state.active = true
    const taskFn = () => new Promise<void>(() => {}); // never resolves — keeps container active
    queue.enqueueTask('test@jid', 'other-task', taskFn);

    const task = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(deriveRuntimeState(task, queue, new Date())).toBe('blocked');
  });

  it('returns "running" when the task is the currently running task', () => {
    const queue = new GroupQueue();
    const taskFn = () => new Promise<void>(() => {}); // never resolves
    queue.enqueueTask('test@jid', 'task-1', taskFn);

    const task = makeTask({ id: 'task-1' });
    expect(deriveRuntimeState(task, queue, new Date())).toBe('running');
  });

  it('returns "queued" when the task is in the pending queue', () => {
    const queue = new GroupQueue();
    // First task occupies the slot
    const firstFn = () => new Promise<void>(() => {});
    queue.enqueueTask('test@jid', 'first-task', firstFn);
    // Second task gets queued
    const secondFn = () => new Promise<void>(() => {});
    queue.enqueueTask('test@jid', 'task-1', secondFn);

    const task = makeTask({ id: 'task-1' });
    expect(deriveRuntimeState(task, queue, new Date())).toBe('queued');
  });
});
