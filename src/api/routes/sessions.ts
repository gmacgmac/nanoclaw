import { Router } from 'express';
import { z } from 'zod';

import { deleteSession, getAllSessions, getSession } from '../../db.js';
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

defineRoute(router, {
  method: 'get',
  path: '/api/sessions/{folder}',
  summary: 'Get session for a group folder',
  description:
    'Returns the active session ID for a specific group folder. 404 if no session exists.',
  request: { params: z.object({ folder: z.string() }) },
  responses: {
    200: {
      description: 'Session found',
      schema: z.object({ data: z.object({ folder: z.string(), sessionId: z.string() }) }),
    },
    404: {
      description: 'No session for this folder',
      schema: z.object({ error: z.string() }),
    },
  },
  handler: async (req, res) => {
    const folder = req.params.folder as string;
    const sessionId = await getSession(folder);
    if (!sessionId) {
      res.status(404).json({ error: `No session for folder '${folder}'` });
      return;
    }
    res.json({ data: { folder, sessionId } });
  },
});

export default router;
