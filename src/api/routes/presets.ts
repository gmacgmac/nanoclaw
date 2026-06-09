import { Router } from 'express';
import { z } from 'zod';

import {
  loadPresets,
  getPresetsHealth,
  readRawPresets,
  writeRawPresets,
  upsertPreset,
  deletePreset,
  validatePresetEntry,
} from '../../presets.js';
import { defineRoute } from '../lib/route-builder.js';
import {
  ModelPresetInputSchema,
  PresetNameParamSchema,
  WriteRawPresetsSchema,
  ApiErrorSchema,
} from '../schemas/index.js';

const router = Router();

// IMPORTANT: static paths (/health, /raw) MUST be registered before /:name

defineRoute(router, {
  method: 'get',
  path: '/api/presets',
  summary: 'List all model presets',
  description:
    'Returns all valid presets from model-presets.json. Returns empty object if file is missing. Returns empty object (with no error) if file is corrupt — use GET /api/presets/health to check parse status.',
  responses: {
    200: {
      description: 'Preset map keyed by preset name',
      schema: z.object({ data: z.record(z.string(), ModelPresetInputSchema) }),
    },
  },
  handler: (_req, res) => {
    res.json({ data: loadPresets() });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/presets/health',
  summary: 'Preset file health check',
  description:
    'Returns parse status of model-presets.json. healthy: false means the file exists but cannot be parsed — use GET /api/presets/raw to retrieve the broken content, fix it, and submit via PUT /api/presets/raw.',
  responses: {
    200: {
      description: 'Health status',
      schema: z.object({
        data: z.object({
          healthy: z.boolean(),
          count: z.number().int(),
          error: z.string().optional(),
          parseError: z.string().optional(),
        }),
      }),
    },
  },
  handler: (_req, res) => {
    res.json({ data: getPresetsHealth() });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/presets/raw',
  summary: 'Get raw presets file content',
  description:
    'Returns the raw text content of model-presets.json. Works even when JSON is malformed. Use this to retrieve broken content for repair.',
  responses: {
    200: {
      description: 'Raw file content',
      schema: z.object({
        data: z.object({
          exists: z.boolean(),
          content: z.string(),
        }),
      }),
    },
  },
  handler: (_req, res) => {
    try {
      const result = readRawPresets();
      res.json({ data: result });
    } catch {
      res
        .status(500)
        .json({ error: 'Failed to read presets file', code: 'READ_ERROR' });
    }
  },
});

defineRoute(router, {
  method: 'put',
  path: '/api/presets/raw',
  summary: 'Replace entire presets file',
  description:
    'Full-file replacement for model-presets.json. Validates that the submitted content is valid JSON and contains at least one valid preset entry before writing. Atomic write (tmp → rename). Use for repairs when individual preset endpoints fail due to corrupt file.',
  request: { body: WriteRawPresetsSchema },
  responses: {
    200: {
      description: 'Write result',
      schema: z.object({
        data: z.object({
          ok: z.boolean(),
          validCount: z.number().int(),
          invalidKeys: z.array(z.string()),
        }),
      }),
    },
    400: {
      description: 'Invalid JSON or no valid preset entries',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const { content } = req.body as { content: string };
    const result = writeRawPresets(content);
    if (!result.ok) {
      res.status(400).json({
        error: result.error,
        code: 'INVALID_CONTENT',
        invalidKeys: result.invalidKeys,
      });
      return;
    }
    res.json({
      data: {
        ok: true,
        validCount: result.validCount,
        invalidKeys: result.invalidKeys ?? [],
      },
    });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/presets/{name}',
  summary: 'Get a single preset',
  description: 'Returns one preset by name.',
  request: { params: PresetNameParamSchema },
  responses: {
    200: {
      description: 'Preset details',
      schema: z.object({
        data: ModelPresetInputSchema.extend({ name: z.string() }),
      }),
    },
    404: {
      description: 'Preset not found',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const { name } = req.params;
    const presets = loadPresets();
    const preset = presets[name as string];
    if (!preset) {
      res
        .status(404)
        .json({ error: `Preset "${name}" not found`, code: 'NOT_FOUND' });
      return;
    }
    res.json({ data: { name, ...preset } });
  },
});

defineRoute(router, {
  method: 'put',
  path: '/api/presets/{name}',
  summary: 'Create or update a preset',
  description:
    'Creates a new preset or fully replaces an existing one. Validates the preset body before writing. Atomic write (tmp → rename). Returns 409 if the presets file is currently corrupt — use PUT /api/presets/raw to repair first.',
  request: {
    params: PresetNameParamSchema,
    body: ModelPresetInputSchema,
  },
  responses: {
    200: {
      description: 'Created or updated preset',
      schema: z.object({
        data: ModelPresetInputSchema.extend({ name: z.string() }),
      }),
    },
    400: {
      description: 'Validation error',
      schema: ApiErrorSchema,
    },
    409: {
      description: 'Presets file is corrupt — repair required',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const { name } = req.params;
    const validated = validatePresetEntry(name as string, req.body);
    if (!validated) {
      res.status(400).json({
        error: 'Preset entry failed internal validation',
        code: 'VALIDATION_ERROR',
      });
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
});

defineRoute(router, {
  method: 'delete',
  path: '/api/presets/{name}',
  summary: 'Delete a preset',
  description:
    'Removes a preset by name. Returns 404 if the preset does not exist. Returns 409 if the presets file is corrupt. Atomic write.',
  request: { params: PresetNameParamSchema },
  responses: {
    200: {
      description: 'Deleted',
      schema: z.object({ ok: z.boolean() }),
    },
    404: {
      description: 'Preset not found',
      schema: ApiErrorSchema,
    },
    409: {
      description: 'Presets file is corrupt — repair required',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const { name } = req.params;
    const result = deletePreset(name as string);
    if (!result.ok) {
      res.status(409).json({ error: result.error, code: result.code });
      return;
    }
    if (!result.found) {
      res
        .status(404)
        .json({ error: `Preset "${name}" not found`, code: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  },
});

export default router;
