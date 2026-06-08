import { Router } from 'express';

import {
  loadPresets,
  getPresetsHealth,
  readRawPresets,
  writeRawPresets,
  upsertPreset,
  deletePreset,
  validatePresetEntry,
} from '../../presets.js';
import { validateBody } from '../middleware/validate.js';
import { ModelPresetInputSchema, WriteRawPresetsSchema } from '../schemas/index.js';

const router = Router();

// IMPORTANT: static paths (/health, /raw) MUST be registered before /:name

router.get('/api/presets', (_req, res) => {
  res.json({ data: loadPresets() });
});

router.get('/api/presets/health', (_req, res) => {
  res.json({ data: getPresetsHealth() });
});

router.get('/api/presets/raw', (_req, res) => {
  try {
    const result = readRawPresets();
    res.json({ data: result });
  } catch {
    res.status(500).json({ error: 'Failed to read presets file', code: 'READ_ERROR' });
  }
});

router.put(
  '/api/presets/raw',
  validateBody(WriteRawPresetsSchema),
  (req, res) => {
    const { content } = req.body as { content: string };
    const result = writeRawPresets(content);
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: 'INVALID_CONTENT', invalidKeys: result.invalidKeys });
      return;
    }
    res.json({ data: { ok: true, validCount: result.validCount, invalidKeys: result.invalidKeys ?? [] } });
  },
);

router.get('/api/presets/:name', (req, res) => {
  const { name } = req.params;
  const presets = loadPresets();
  const preset = presets[name as string];
  if (!preset) {
    res.status(404).json({ error: `Preset "${name}" not found`, code: 'NOT_FOUND' });
    return;
  }
  res.json({ data: { name, ...preset } });
});

router.put(
  '/api/presets/:name',
  validateBody(ModelPresetInputSchema),
  (req, res) => {
    const { name } = req.params;
    const validated = validatePresetEntry(name as string, req.body);
    if (!validated) {
      res.status(400).json({ error: 'Preset entry failed internal validation', code: 'VALIDATION_ERROR' });
      return;
    }
    const result = upsertPreset(name as string, validated);
    if (!result.ok) {
      const status = result.code === 'PRESETS_CORRUPT' ? 409 : 400;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ data: { name, ...validated } });
  },
);

router.delete('/api/presets/:name', (req, res) => {
  const { name } = req.params;
  const result = deletePreset(name as string);
  if (!result.ok) {
    res.status(409).json({ error: result.error, code: result.code });
    return;
  }
  if (!result.found) {
    res.status(404).json({ error: `Preset "${name}" not found`, code: 'NOT_FOUND' });
    return;
  }
  res.json({ ok: true });
});

export default router;
