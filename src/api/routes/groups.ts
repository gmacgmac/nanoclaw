import { Router } from 'express';

import { DEFAULT_TRIGGER } from '../../config.js';
import {
  deleteGroup,
  getRegisteredGroup,
  getRegisteredGroups,
  registerGroup,
  updateRegisteredGroup,
} from '../../group-registry.js';
import { getAvailablePresetNames, resolvePreset } from '../../presets.js';
import { validateBody } from '../middleware/validate.js';
import {
  CreateGroupSchema,
  PatchConfigSchema,
  SwitchPresetSchema,
  UpdateGroupSchema,
} from '../schemas/index.js';
import type { RegisteredGroup } from '../../types.js';

const router = Router();

router.get('/api/groups', (_req, res) => {
  const groups = getRegisteredGroups();
  const data = Object.entries(groups).map(([jid, g]) => ({ jid, ...g }));
  res.json({ data });
});

router.get('/api/groups/:jid', (req, res) => {
  const jid = req.params.jid as string;
  const group = getRegisteredGroup(jid);
  if (!group) {
    res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ data: { jid, ...group } });
});

router.get('/api/groups/:jid/config', (req, res) => {
  const jid = req.params.jid as string;
  const group = getRegisteredGroup(jid);
  if (!group) {
    res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ data: group.containerConfig ?? {} });
});

router.post(
  '/api/groups',
  validateBody(CreateGroupSchema),
  async (req, res) => {
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
      res
        .status(409)
        .json({ error: 'Group already exists', code: 'CONFLICT' });
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
);

router.patch(
  '/api/groups/:jid',
  validateBody(UpdateGroupSchema),
  async (req, res) => {
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
);

router.patch(
  '/api/groups/:jid/config',
  validateBody(PatchConfigSchema),
  async (req, res) => {
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
);

router.patch(
  '/api/groups/:jid/preset',
  validateBody(SwitchPresetSchema),
  async (req, res) => {
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
);

router.delete('/api/groups/:jid', async (req, res) => {
  const deleted = await deleteGroup(req.params.jid as string);
  if (!deleted) {
    res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ ok: true });
});

export default router;
