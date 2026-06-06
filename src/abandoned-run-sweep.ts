import { getOrphanedStartedRuns, getTaskById, updateTaskRunLog } from './db.js';
import { logger } from './logger.js';

export interface SweepDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Sweep orphaned 'started' task_run_logs rows left by a host crash.
 * Closes them as errors and sends one aggregated alert per affected group.
 * Should be called at startup, after DB init but before the scheduler loop.
 */
export async function sweepAbandonedRuns(
  deps: SweepDependencies,
): Promise<void> {
  const orphans = await getOrphanedStartedRuns();
  if (orphans.length === 0) return;

  logger.warn(
    { count: orphans.length },
    'Found orphaned task runs from previous crash',
  );

  // Close out each orphan and group by chat_jid for alerts
  const alertsByJid = new Map<string, string[]>();

  for (const orphan of orphans) {
    await updateTaskRunLog(orphan.id, {
      status: 'error',
      error: 'Host stopped mid-run',
      duration_ms: 0,
    });

    const task = await getTaskById(orphan.task_id);
    const chatJid = task?.chat_jid;
    if (!chatJid) continue;

    const label = task.description || task.prompt.slice(0, 60) || task.id;
    const existing = alertsByJid.get(chatJid) || [];
    existing.push(label);
    alertsByJid.set(chatJid, existing);
  }

  // Send one aggregated alert per group
  for (const [jid, labels] of alertsByJid) {
    const lines = labels.map((l) => `- ${l}`).join('\n');
    const message = `⚠️ ${labels.length} task run(s) abandoned during last shutdown:\n${lines}`;
    try {
      await deps.sendMessage(jid, message);
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send abandoned-run alert to group');
    }
  }

  logger.info(
    { closedCount: orphans.length, groupsNotified: alertsByJid.size },
    'Abandoned run sweep complete',
  );
}
