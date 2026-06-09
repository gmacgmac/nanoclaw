import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import {
  getRegisteredGroup,
  updateRegisteredGroup,
} from '../../group-registry.js';
import { JidSchema } from '../schemas/common.js';
import {
  McpServersPatchSchema,
  McpServersPutSchema,
  StringArrayPatchSchema,
  StringArrayPutSchema,
  FieldValueResponseSchema,
} from '../schemas/config-array-fields.js';
import { ApiErrorSchema } from '../schemas/index.js';
import { defineRoute } from '../lib/route-builder.js';
import type { RegisteredGroup } from '../../types.js';

const router = Router();

// --- Per-field on-disk validators ---

function listAvailableSkills(): string[] {
  const dir = path.join(process.cwd(), 'container', 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((entry) => {
    try {
      return fs.statSync(path.join(dir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listAvailableHooks(): string[] {
  const dir = path.join(process.cwd(), 'docs', 'hooks');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

type StringArrayValidator = (items: string[]) => { invalid: string[] };

function makeDirValidator(
  available: string[],
  _label: string,
): StringArrayValidator {
  const set = new Set(available);
  return (items) => ({
    invalid: items.filter((i) => !set.has(i)),
  });
}

const nonEmptyValidator: StringArrayValidator = (items) => {
  const invalid = items.filter((i) => typeof i !== 'string' || i.trim() === '');
  return { invalid };
};

// --- Field registry ---

interface StringArrayField {
  kind: 'string-array';
  urlSegment: string;
  configKey: string;
  label: string;
  validator: StringArrayValidator;
}

interface MapField {
  kind: 'map';
  urlSegment: string;
  configKey: string;
  label: string;
}

type FieldDef = StringArrayField | MapField;

const availableSkills = listAvailableSkills();
const availableHooks = listAvailableHooks();

const FIELD_DEFS: FieldDef[] = [
  {
    kind: 'string-array',
    urlSegment: 'skills',
    configKey: 'skills',
    label: 'skills',
    validator: makeDirValidator(availableSkills, 'skills'),
  },
  {
    kind: 'map',
    urlSegment: 'mcp-servers',
    configKey: 'mcpServers',
    label: 'mcpServers',
  },
  {
    kind: 'string-array',
    urlSegment: 'hooks',
    configKey: 'hooks',
    label: 'hooks',
    validator: makeDirValidator(availableHooks, 'hooks'),
  },
  {
    kind: 'string-array',
    urlSegment: 'allowed-host-commands',
    configKey: 'allowedHostCommands',
    label: 'allowedHostCommands',
    validator: nonEmptyValidator,
  },
  {
    kind: 'string-array',
    urlSegment: 'denied-tools',
    configKey: 'deniedTools',
    label: 'deniedTools',
    validator: nonEmptyValidator,
  },
  {
    kind: 'string-array',
    urlSegment: 'command-allowlist',
    configKey: 'commandAllowlist',
    label: 'commandAllowlist',
    validator: nonEmptyValidator,
  },
];

// --- Persistence helpers ---

async function loadGroup(
  jid: string,
  res: import('express').Response,
): Promise<RegisteredGroup | null> {
  const group = getRegisteredGroup(jid);
  if (!group) {
    res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
    return null;
  }
  return group;
}

async function persistField(
  jid: string,
  group: RegisteredGroup,
  configKey: string,
  newValue: unknown,
): Promise<void> {
  const nextConfig = {
    ...(group.containerConfig ?? {}),
    [configKey]: newValue,
  };
  const updated: RegisteredGroup = {
    ...group,
    containerConfig: nextConfig as RegisteredGroup['containerConfig'],
  };
  await updateRegisteredGroup(jid, updated);
}

// --- Handlers ---

function makeGetHandler(field: FieldDef) {
  return async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
    const jid = req.params.jid as string;
    const group = await loadGroup(jid, res);
    if (!group) return;
    const config = (group.containerConfig ?? {}) as Record<string, unknown>;
    const current = config[field.configKey];
    res.json({ data: { [field.configKey]: current } });
  };
}

function makePatchHandler(field: FieldDef) {
  return async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
    const jid = req.params.jid as string;
    const group = await loadGroup(jid, res);
    if (!group) return;

    if (field.kind === 'string-array') {
      const { add = [], remove = [] } = req.body as z.infer<
        typeof StringArrayPatchSchema
      >;
      const all = [...add, ...remove];
      const { invalid } = field.validator(all);
      if (invalid.length > 0) {
        res.status(400).json({
          error: `Invalid ${field.label}: ${invalid.join(', ')}`,
          code: 'INVALID_VALUE',
        });
        return;
      }
      const config = (group.containerConfig ?? {}) as Record<string, unknown>;
      const current = (config[field.configKey] ?? []) as string[];
      const set = new Set(remove);
      const next = [
        ...current.filter((item) => !set.has(item)),
        ...add.filter((item) => !current.includes(item)),
      ];
      await persistField(jid, group, field.configKey, next);
      res.json({ data: { [field.configKey]: next } });
      return;
    }

    // map (mcpServers)
    const { add = {}, remove = [] } = req.body as z.infer<
      typeof McpServersPatchSchema
    >;
    const config = (group.containerConfig ?? {}) as Record<string, unknown>;
    const current = (config[field.configKey] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current, ...add };
    for (const key of remove) {
      delete next[key];
    }
    await persistField(jid, group, field.configKey, next);
    res.json({ data: { [field.configKey]: next } });
  };
}

function makePutHandler(field: FieldDef) {
  return async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
    const jid = req.params.jid as string;
    const group = await loadGroup(jid, res);
    if (!group) return;

    if (field.kind === 'string-array') {
      const { value } = req.body as z.infer<typeof StringArrayPutSchema>;
      const { invalid } = field.validator(value);
      if (invalid.length > 0) {
        res.status(400).json({
          error: `Invalid ${field.label}: ${invalid.join(', ')}`,
          code: 'INVALID_VALUE',
        });
        return;
      }
      await persistField(jid, group, field.configKey, value);
      res.json({ data: { [field.configKey]: value } });
      return;
    }

    // map (mcpServers)
    const { value } = req.body as z.infer<typeof McpServersPutSchema>;
    await persistField(jid, group, field.configKey, value);
    res.json({ data: { [field.configKey]: value } });
  };
}

// --- Route registration ---

for (const field of FIELD_DEFS) {
  const pathBase = `/api/groups/{jid}/${field.urlSegment}`;

  defineRoute(router, {
    method: 'get',
    path: pathBase,
    summary: `Get ${field.label}`,
    description:
      field.kind === 'map'
        ? `Returns the current ${field.label} map for the group. \`undefined\` if unset.`
        : `Returns the current ${field.label} array for the group. \`undefined\` if unset.`,
    request: { params: z.object({ jid: JidSchema }) },
    responses: {
      200: {
        description: `${field.label} value`,
        schema: FieldValueResponseSchema,
      },
      404: { description: 'Group not found', schema: ApiErrorSchema },
    },
    handler: makeGetHandler(field),
  });

  defineRoute(router, {
    method: 'patch',
    path: pathBase,
    summary:
      field.kind === 'map'
        ? `Add/remove ${field.label}`
        : `Add/remove ${field.label}`,
    description:
      field.kind === 'map'
        ? `Add entries (merged by key, overwriting existing) and/or remove keys from ${field.label}. Idempotent.`
        : `Append items via \`add\` and/or drop items via \`remove\`. Duplicates against the current value are silently dropped; absent items removed are silently skipped. Idempotent.`,
    request: {
      params: z.object({ jid: JidSchema }),
      body:
        field.kind === 'map' ? McpServersPatchSchema : StringArrayPatchSchema,
    },
    responses: {
      200: {
        description: `Updated ${field.label}`,
        schema: FieldValueResponseSchema,
      },
      400: { description: 'Validation error', schema: ApiErrorSchema },
      404: { description: 'Group not found', schema: ApiErrorSchema },
    },
    handler: makePatchHandler(field),
  });

  defineRoute(router, {
    method: 'put',
    path: pathBase,
    summary: `Replace ${field.label}`,
    description:
      field.kind === 'map'
        ? `Replace the entire ${field.label} map with \`value\`. The full map must be supplied.`
        : `Replace the entire ${field.label} array with \`value\`. The full array must be supplied.`,
    request: {
      params: z.object({ jid: JidSchema }),
      body: field.kind === 'map' ? McpServersPutSchema : StringArrayPutSchema,
    },
    responses: {
      200: {
        description: `Replaced ${field.label}`,
        schema: FieldValueResponseSchema,
      },
      400: { description: 'Validation error', schema: ApiErrorSchema },
      404: { description: 'Group not found', schema: ApiErrorSchema },
    },
    handler: makePutHandler(field),
  });
}

export default router;
