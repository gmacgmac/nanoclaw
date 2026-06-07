import { Router } from 'express';

import { deleteSession, getAllSessions } from '../../db.js';

const router = Router();

router.get('/api/sessions', async (_req, res) => {
  const sessions = await getAllSessions();
  res.json({ data: sessions });
});

router.delete('/api/sessions/:folder', async (req, res) => {
  await deleteSession(req.params.folder as string);
  res.json({ ok: true });
});

export default router;
