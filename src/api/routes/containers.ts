import { Router } from 'express';

import type { GroupQueue } from '../../group-queue.js';

export function createContainerRoutes(queue: GroupQueue) {
  const router = Router();

  router.get('/api/containers', (_req, res) => {
    res.json({ data: queue.getStatus() });
  });

  router.post('/api/containers/:jid/stop', (req, res) => {
    const wasRunning = queue.closeStdin(req.params.jid as string);
    res.json({ ok: true, wasRunning });
  });

  return router;
}
