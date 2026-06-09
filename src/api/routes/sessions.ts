import { Router } from 'express';
import { z } from 'zod';

import { deleteSession, getAllSessions } from '../../db.js';
import { defineRoute } from '../lib/route-builder.js';

const router = Router();

defineRoute(router, {
  method: 'get',
  path: '/api/sessions',
  summary: 'List all active sessions',
  description:
    'Returns group_folder → session_id mapping for all groups with active Claude sessions.',
  responses: {
    200: {
      description: 'Session map',
      schema: z.object({ data: z.record(z.string(), z.string()) }),
    },
  },
  handler: async (_req, res) => {
    const sessions = await getAllSessions();
    res.json({ data: sessions });
  },
});

defineRoute(router, {
  method: 'delete',
  path: '/api/sessions/{folder}',
  summary: 'Clear a group session',
  description:
    'Deletes the stored session ID for the given group folder. Equivalent to /newsession host command. Next message starts a fresh conversation.',
  request: { params: z.object({ folder: z.string() }) },
  responses: {
    200: {
      description: 'Session cleared',
      schema: z.object({ ok: z.boolean() }),
    },
  },
  handler: async (req, res) => {
    await deleteSession(req.params.folder as string);
    res.json({ ok: true });
  },
});

export default router;
