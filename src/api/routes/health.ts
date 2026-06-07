import { Router } from 'express';

import { testConnection } from '../../db.js';
import type { GroupQueue } from '../../group-queue.js';

export function createHealthRoute(queue: GroupQueue) {
  const router = Router();
  const startTime = Date.now();

  router.get('/api/health', async (_req, res) => {
    let dbOk = false;
    try {
      dbOk = await testConnection();
    } catch {
      dbOk = false;
    }

    const status = queue.getStatus();
    const activeCount = status.filter((s) => s.active).length;

    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      db: dbOk,
      queueDepth: activeCount,
    });
  });

  return router;
}
