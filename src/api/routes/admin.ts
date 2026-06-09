import { Router } from 'express';
import { z } from 'zod';

import { reloadGroups } from '../../group-registry.js';
import { defineRoute } from '../lib/route-builder.js';

const router = Router();

defineRoute(router, {
  method: 'post',
  path: '/api/admin/reload-groups',
  summary: 'Reload groups from database',
  description:
    'Re-reads all registered groups from PostgreSQL and replaces the in-memory cache. Use only after emergency direct-SQL edits. Normal API writes keep the cache in sync automatically.',
  responses: {
    200: {
      description: 'Reload result',
      schema: z.object({ ok: z.boolean(), count: z.number() }),
    },
  },
  handler: async (_req, res) => {
    const count = await reloadGroups();
    res.json({ ok: true, count });
  },
});

export default router;
