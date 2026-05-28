import { GroupQueue } from './group-queue.js';
import { RuntimeState, ScheduledTask } from './types.js';

/**
 * Derive the live runtime state for a scheduled task.
 * Pure function — reads GroupQueue state + DB row, no side effects.
 *
 * State derivation table:
 *   running  — task is the currently executing task for its group
 *   queued   — task is in the pending queue for its group
 *   blocked  — task is due but group has an active container (not yet queued/running)
 *   due      — task is due and group has no active container
 *   idle     — task is active but next_run is in the future
 *   null     — task is paused or completed (no runtime concept)
 */
export function deriveRuntimeState(
  task: ScheduledTask,
  queue: GroupQueue,
  now: Date,
): RuntimeState {
  // Paused or completed tasks have no runtime state
  if (task.status === 'paused' || task.status === 'completed') {
    return null;
  }

  const groupJid = task.chat_jid;

  // Check running first (most specific)
  if (queue.isTaskRunning(groupJid, task.id)) {
    return 'running';
  }

  // Check queued
  if (queue.isTaskQueued(groupJid, task.id)) {
    return 'queued';
  }

  // Check if task is due (next_run <= now)
  if (task.next_run) {
    const nextRun = new Date(task.next_run);
    if (nextRun <= now) {
      // Due — but is it blocked by an active container?
      if (queue.hasActiveContainer(groupJid)) {
        return 'blocked';
      }
      return 'due';
    }
  }

  // Active task with next_run in the future (or null next_run for 'once' tasks that haven't been scheduled yet)
  return 'idle';
}
