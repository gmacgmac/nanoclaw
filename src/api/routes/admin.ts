import { Router } from 'express';

import { reloadGroups } from '../../group-registry.js';

const router = Router();

router.post('/api/admin/reload-groups', async (_req, res) => {
  const count = await reloadGroups();
  res.json({ ok: true, count });
});

export default router;
