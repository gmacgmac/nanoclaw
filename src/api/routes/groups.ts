import { Router } from 'express';
import { z } from 'zod';

import { DEFAULT_TRIGGER } from '../../config.js';
import {
  deleteGroup,
  getRegisteredGroup,
  getRegisteredGroups,
  registerGroup,
  updateRegisteredGroup,
} from '../../group-registry.js';
import { getAvailablePresetNames, resolvePreset } from '../../presets.js';
import { defineRoute } from '../lib/route-builder.js';
import {
  CreateGroupSchema,
  JidSchema,
  PatchConfigSchema,
  SwitchPresetSchema,
  UpdateGroupSchema,
  GroupResponseSchema,
  GroupListResponseSchema,
  ApiErrorSchema,
  ContainerConfigSchema,
} from '../schemas/index.js';
import type { RegisteredGroup } from '../../types.js';

const router = Router();

const GroupConfigResponseSchema = z.object({ data: ContainerConfigSchema });
const GroupDeleteResponseSchema = z.object({ ok: z.boolean() });

defineRoute(router, {
  method: 'get',
  path: '/api/groups',
  summary: 'List all registered groups',
  description:
    'Returns all registered groups with their full configuration. Reads from in-memory cache (always in sync with DB).',
  responses: {
    200: {
      description: 'Group list',
      schema: GroupListResponseSchema,
    },
  },
  handler: (_req, res) => {
    const groups = getRegisteredGroups();
    const data = Object.entries(groups).map(([jid, g]) => ({ jid, ...g }));
    res.json({ data });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/groups/{jid}',
  summary: 'Get a single group',
  description: 'Returns one group by JID with full containerConfig.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Group details',
      schema: GroupResponseSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const jid = req.params.jid as string;
    const group = getRegisteredGroup(jid);
    if (!group) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ data: { jid, ...group } });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/groups/{jid}/config',
  summary: 'Get group containerConfig',
  description:
    'Returns only the containerConfig object for a group. Returns {} if no config is set.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Container config',
      schema: GroupConfigResponseSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: (req, res) => {
    const jid = req.params.jid as string;
    const group = getRegisteredGroup(jid);
    if (!group) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ data: group.containerConfig ?? {} });
  },
});

defineRoute(router, {
  method: 'post',
  path: '/api/groups',
  summary: 'Register a new group',
  description:
    'Creates a new group. Creates the group folder on disk, seeds CLAUDE.md and memory files from templates.',
  request: { body: CreateGroupSchema },
  responses: {
    201: {
      description: 'Group created',
      schema: GroupResponseSchema,
    },
    400: {
      description: 'Validation error',
      schema: ApiErrorSchema,
    },
    409: {
      description: 'Group already exists (JID or folder conflict)',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const {
      jid,
      name,
      folder,
      trigger,
      containerConfig,
      requiresTrigger,
      isMain,
      isAdmin,
      containerChannel,
    } = req.body;
    if (getRegisteredGroup(jid)) {
      res.status(409).json({ error: 'Group already exists', code: 'CONFLICT' });
      return;
    }

    const group: RegisteredGroup = {
      name,
      folder,
      trigger: trigger ?? DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      containerConfig,
      requiresTrigger: requiresTrigger ?? true,
      isMain: isMain ?? false,
      isAdmin: isAdmin ?? false,
      containerChannel,
    };
    await registerGroup(jid, group);
    res.status(201).json({ data: { jid, ...group } });
  },
});

defineRoute(router, {
  method: 'patch',
  path: '/api/groups/{jid}',
  summary: 'Update group top-level fields',
  description:
    'Updates name, trigger, requiresTrigger, multiAgentRouter, or containerChannel. Does NOT touch containerConfig.',
  request: {
    params: z.object({ jid: JidSchema }),
    body: UpdateGroupSchema,
  },
  responses: {
    200: {
      description: 'Updated group',
      schema: GroupResponseSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const jid = req.params.jid as string;
    const current = getRegisteredGroup(jid);
    if (!current) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }

    const updated: RegisteredGroup = { ...current };
    if (req.body.name !== undefined) updated.name = req.body.name;
    if (req.body.trigger !== undefined) updated.trigger = req.body.trigger;
    if (req.body.requiresTrigger !== undefined)
      updated.requiresTrigger = req.body.requiresTrigger;
    if (req.body.multiAgentRouter !== undefined)
      updated.multiAgentRouter = req.body.multiAgentRouter;
    if (req.body.containerChannel !== undefined)
      updated.containerChannel = req.body.containerChannel;

    await updateRegisteredGroup(jid, updated);
    res.json({ data: { jid, ...updated } });
  },
});

defineRoute(router, {
  method: 'patch',
  path: '/api/groups/{jid}/config',
  summary: 'Merge-patch containerConfig',
  description:
    'Partially updates containerConfig using shallow merge at the top level. ' +
    'Only provided fields change — omitted fields are untouched. Set a field to null to remove it.\n\n' +
    '**Merge behavior:**\n' +
    '- Scalar/array fields (preset, skills, timeout, deniedTools, etc.): safe to send individually. ' +
    'Sending `{"preset": "claude-opus"}` changes only the preset; everything else is preserved.\n' +
    '- Object/array-of-object fields (mcpServers, additionalMounts): REPLACED WHOLESALE when included. ' +
    'If you send `{"mcpServers": {"brave": {...}}}` and the group has 3 existing servers, you end up with 1.\n\n' +
    '**To safely update mcpServers or additionalMounts:** GET /api/groups/{jid}/config first, merge your changes into the existing object/array locally, then PATCH with the complete value.',
  request: {
    params: z.object({ jid: JidSchema }),
    body: PatchConfigSchema,
  },
  responses: {
    200: {
      description: 'Updated group',
      schema: GroupResponseSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const jid = req.params.jid as string;
    const current = getRegisteredGroup(jid);
    if (!current) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }

    const currentConfig = current.containerConfig ?? {};
    const patch = req.body as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...currentConfig };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    const updated: RegisteredGroup = {
      ...current,
      containerConfig: merged as RegisteredGroup['containerConfig'],
    };
    await updateRegisteredGroup(jid, updated);
    res.json({ data: { jid, ...updated } });
  },
});

defineRoute(router, {
  method: 'patch',
  path: '/api/groups/{jid}/preset',
  summary: 'Switch model preset',
  description:
    'Changes the group primary model preset. Must match a key in model-presets.json. Running container is not affected until next spawn.',
  request: {
    params: z.object({ jid: JidSchema }),
    body: SwitchPresetSchema,
  },
  responses: {
    200: {
      description: 'Updated group',
      schema: GroupResponseSchema,
    },
    400: {
      description: 'Unknown preset',
      schema: ApiErrorSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const jid = req.params.jid as string;
    const current = getRegisteredGroup(jid);
    if (!current) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }

    const resolved = resolvePreset(req.body.preset);
    if (!resolved) {
      const available = getAvailablePresetNames();
      res.status(400).json({
        error: `Unknown preset "${req.body.preset}". Available: ${available.join(', ')}`,
        code: 'INVALID_PRESET',
      });
      return;
    }

    const updated: RegisteredGroup = {
      ...current,
      containerConfig: {
        ...(current.containerConfig ?? {}),
        preset: req.body.preset,
      },
    };
    await updateRegisteredGroup(jid, updated);
    res.json({ data: { jid, ...updated } });
  },
});

defineRoute(router, {
  method: 'delete',
  path: '/api/groups/{jid}',
  summary: 'Unregister a group',
  description:
    'Removes the group from registry and DB. Does NOT delete the group folder on disk (data preservation).',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Group removed',
      schema: GroupDeleteResponseSchema,
    },
    404: {
      description: 'Group not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const deleted = await deleteGroup(req.params.jid as string);
    if (!deleted) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  },
});

export default router;
