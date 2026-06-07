import { Router } from 'express';

import { loadPresets } from '../../presets.js';

const router = Router();

router.get('/api/presets', (_req, res) => {
  res.json({ data: loadPresets() });
});

export default router;
