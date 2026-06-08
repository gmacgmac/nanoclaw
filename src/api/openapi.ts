import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
// `extendZodWithOpenApi(z)` is called by `./zod-openapi-init.js`, which is
// imported as a side-effect at the top of `./schemas/index.js` (and re-runs
// idempotently here if needed). Calling it before importing schemas is
// required — `OpenAPIRegistry.register()` calls `schema.openapi(refId)`
// internally, and the method only exists after the prototype patch.
import {
  JidSchema,
  ContainerConfigSchema,
  RegisteredGroupSchema,
  CreateGroupSchema,
  UpdateGroupSchema,
  PatchConfigSchema,
  SwitchPresetSchema,
  GroupResponseSchema,
  GroupListResponseSchema,
  ApiErrorSchema,
  ModelCapabilitiesSchema,
  ModelPresetInputSchema,
  PresetNameParamSchema,
  WriteRawPresetsSchema,
} from './schemas/index.js';

export const registry = new OpenAPIRegistry();

// --- Register reusable schemas as components ---
registry.register('RegisteredGroup', RegisteredGroupSchema);
registry.register('ContainerConfig', ContainerConfigSchema);
registry.register('CreateGroup', CreateGroupSchema);
registry.register('UpdateGroup', UpdateGroupSchema);
registry.register('PatchConfig', PatchConfigSchema);
registry.register('SwitchPreset', SwitchPresetSchema);
registry.register('ApiError', ApiErrorSchema);
registry.register('ModelCapabilities', ModelCapabilitiesSchema);
registry.register('ModelPresetInput', ModelPresetInputSchema);
registry.register('WriteRawPresets', WriteRawPresetsSchema);

// --- Group endpoints ---

// GET /api/groups
registry.registerPath({
  method: 'get',
  path: '/api/groups',
  summary: 'List all registered groups',
  description:
    'Returns all registered groups with their full configuration. Reads from in-memory cache (always in sync with DB).',
  responses: {
    200: {
      description: 'Group list',
      content: { 'application/json': { schema: GroupListResponseSchema } },
    },
  },
});

// GET /api/groups/{jid}
registry.registerPath({
  method: 'get',
  path: '/api/groups/{jid}',
  summary: 'Get a single group',
  description: 'Returns one group by JID with full containerConfig.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Group details',
      content: { 'application/json': { schema: GroupResponseSchema } },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// GET /api/groups/{jid}/config
registry.registerPath({
  method: 'get',
  path: '/api/groups/{jid}/config',
  summary: 'Get group containerConfig',
  description:
    'Returns only the containerConfig object for a group. Returns {} if no config is set.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Container config',
      content: {
        'application/json': {
          schema: z.object({ data: ContainerConfigSchema }),
        },
      },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// POST /api/groups
registry.registerPath({
  method: 'post',
  path: '/api/groups',
  summary: 'Register a new group',
  description:
    'Creates a new group. Creates the group folder on disk, seeds CLAUDE.md and memory files from templates.',
  request: {
    body: { content: { 'application/json': { schema: CreateGroupSchema } } },
  },
  responses: {
    201: {
      description: 'Group created',
      content: { 'application/json': { schema: GroupResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Group already exists (JID or folder conflict)',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// PATCH /api/groups/{jid}
registry.registerPath({
  method: 'patch',
  path: '/api/groups/{jid}',
  summary: 'Update group top-level fields',
  description:
    'Updates name, trigger, requiresTrigger, multiAgentRouter, or containerChannel. Does NOT touch containerConfig.',
  request: {
    params: z.object({ jid: JidSchema }),
    body: { content: { 'application/json': { schema: UpdateGroupSchema } } },
  },
  responses: {
    200: {
      description: 'Updated group',
      content: { 'application/json': { schema: GroupResponseSchema } },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// PATCH /api/groups/{jid}/config
registry.registerPath({
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
    body: { content: { 'application/json': { schema: PatchConfigSchema } } },
  },
  responses: {
    200: {
      description: 'Updated group',
      content: { 'application/json': { schema: GroupResponseSchema } },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// PATCH /api/groups/{jid}/preset
registry.registerPath({
  method: 'patch',
  path: '/api/groups/{jid}/preset',
  summary: 'Switch model preset',
  description:
    'Changes the group primary model preset. Must match a key in model-presets.json. Running container is not affected until next spawn.',
  request: {
    params: z.object({ jid: JidSchema }),
    body: { content: { 'application/json': { schema: SwitchPresetSchema } } },
  },
  responses: {
    200: {
      description: 'Updated group',
      content: { 'application/json': { schema: GroupResponseSchema } },
    },
    400: {
      description: 'Unknown preset',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// DELETE /api/groups/{jid}
registry.registerPath({
  method: 'delete',
  path: '/api/groups/{jid}',
  summary: 'Unregister a group',
  description:
    'Removes the group from registry and DB. Does NOT delete the group folder on disk (data preservation).',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Group removed',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: {
      description: 'Group not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// --- Presets, sessions, containers, health, admin ---

// GET /api/presets
registry.registerPath({
  method: 'get',
  path: '/api/presets',
  summary: 'List all model presets',
  description:
    'Returns all valid presets from model-presets.json. Returns empty object if file is missing. Returns empty object (with no error) if file is corrupt — use GET /api/presets/health to check parse status.',
  responses: {
    200: {
      description: 'Preset map keyed by preset name',
      content: {
        'application/json': {
          schema: z.object({
            data: z.record(z.string(), ModelPresetInputSchema),
          }),
        },
      },
    },
  },
});

// GET /api/presets/health
registry.registerPath({
  method: 'get',
  path: '/api/presets/health',
  summary: 'Preset file health check',
  description:
    'Returns parse status of model-presets.json. healthy: false means the file exists but cannot be parsed — use GET /api/presets/raw to retrieve the broken content, fix it, and submit via PUT /api/presets/raw.',
  responses: {
    200: {
      description: 'Health status',
      content: {
        'application/json': {
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
    },
  },
});

// GET /api/presets/raw
registry.registerPath({
  method: 'get',
  path: '/api/presets/raw',
  summary: 'Get raw presets file content',
  description:
    'Returns the raw text content of model-presets.json. Works even when JSON is malformed. Use this to retrieve broken content for repair.',
  responses: {
    200: {
      description: 'Raw file content',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              exists: z.boolean(),
              content: z.string(),
            }),
          }),
        },
      },
    },
  },
});

// PUT /api/presets/raw
registry.registerPath({
  method: 'put',
  path: '/api/presets/raw',
  summary: 'Replace entire presets file',
  description:
    'Full-file replacement for model-presets.json. Validates that the submitted content is valid JSON and contains at least one valid preset entry before writing. Atomic write (tmp → rename). Use for repairs when individual preset endpoints fail due to corrupt file.',
  request: {
    body: {
      content: { 'application/json': { schema: WriteRawPresetsSchema } },
    },
  },
  responses: {
    200: {
      description: 'Write result',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              ok: z.boolean(),
              validCount: z.number().int(),
              invalidKeys: z.array(z.string()),
            }),
          }),
        },
      },
    },
    400: {
      description: 'Invalid JSON or no valid preset entries',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// GET /api/presets/:name
registry.registerPath({
  method: 'get',
  path: '/api/presets/{name}',
  summary: 'Get a single preset',
  description: 'Returns one preset by name.',
  request: { params: PresetNameParamSchema },
  responses: {
    200: {
      description: 'Preset details',
      content: {
        'application/json': {
          schema: z.object({
            data: ModelPresetInputSchema.extend({ name: z.string() }),
          }),
        },
      },
    },
    404: {
      description: 'Preset not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// PUT /api/presets/:name
registry.registerPath({
  method: 'put',
  path: '/api/presets/{name}',
  summary: 'Create or update a preset',
  description:
    'Creates a new preset or fully replaces an existing one. Validates the preset body before writing. Atomic write (tmp → rename). Returns 409 if the presets file is currently corrupt — use PUT /api/presets/raw to repair first.',
  request: {
    params: PresetNameParamSchema,
    body: {
      content: { 'application/json': { schema: ModelPresetInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Created or updated preset',
      content: {
        'application/json': {
          schema: z.object({
            data: ModelPresetInputSchema.extend({ name: z.string() }),
          }),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Presets file is corrupt — repair required',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// DELETE /api/presets/:name
registry.registerPath({
  method: 'delete',
  path: '/api/presets/{name}',
  summary: 'Delete a preset',
  description:
    'Removes a preset by name. Returns 404 if the preset does not exist. Returns 409 if the presets file is corrupt. Atomic write.',
  request: { params: PresetNameParamSchema },
  responses: {
    200: {
      description: 'Deleted',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: {
      description: 'Preset not found',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
    409: {
      description: 'Presets file is corrupt — repair required',
      content: { 'application/json': { schema: ApiErrorSchema } },
    },
  },
});

// GET /api/sessions
registry.registerPath({
  method: 'get',
  path: '/api/sessions',
  summary: 'List all active sessions',
  description:
    'Returns group_folder → session_id mapping for all groups with active Claude sessions.',
  responses: {
    200: {
      description: 'Session map',
      content: {
        'application/json': {
          schema: z.object({ data: z.record(z.string(), z.string()) }),
        },
      },
    },
  },
});

// DELETE /api/sessions/{folder}
registry.registerPath({
  method: 'delete',
  path: '/api/sessions/{folder}',
  summary: 'Clear a group session',
  description:
    'Deletes the stored session ID for the given group folder. Equivalent to /newsession host command. Next message starts a fresh conversation.',
  request: { params: z.object({ folder: z.string() }) },
  responses: {
    200: {
      description: 'Session cleared',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

// GET /api/containers
registry.registerPath({
  method: 'get',
  path: '/api/containers',
  summary: 'Container queue status',
  description:
    'Returns the runtime state of all groups in the queue: active, idle-waiting, pending messages, pending tasks count, container name.',
  responses: {
    200: {
      description: 'Container status array',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(
              z.object({
                jid: z.string(),
                active: z.boolean(),
                idleWaiting: z.boolean(),
                pendingMessages: z.boolean(),
                pendingTasks: z.number(),
                containerName: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// POST /api/containers/{jid}/stop
registry.registerPath({
  method: 'post',
  path: '/api/containers/{jid}/stop',
  summary: 'Stop a running container',
  description:
    'Writes a close sentinel to the group IPC input directory, signalling the agent to wind down. No-op if no container is running. Equivalent to /shutdown host command.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Stop result',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), wasRunning: z.boolean() }),
        },
      },
    },
  },
});

// GET /api/health
registry.registerPath({
  method: 'get',
  path: '/api/health',
  summary: 'Health check',
  description:
    'Returns process uptime in seconds, PostgreSQL connectivity boolean, and count of active containers.',
  responses: {
    200: {
      description: 'Health status',
      content: {
        'application/json': {
          schema: z.object({
            status: z.string(),
            uptime: z.number(),
            db: z.boolean(),
            queueDepth: z.number(),
          }),
        },
      },
    },
  },
});

// POST /api/admin/reload-groups
registry.registerPath({
  method: 'post',
  path: '/api/admin/reload-groups',
  summary: 'Reload groups from database',
  description:
    'Re-reads all registered groups from PostgreSQL and replaces the in-memory cache. Use only after emergency direct-SQL edits. Normal API writes keep the cache in sync automatically.',
  responses: {
    200: {
      description: 'Reload result',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), count: z.number() }),
        },
      },
    },
  },
});

/**
 * Generate the complete OpenAPI 3.1 document from registered schemas and paths.
 * Called on each request to /api/openapi.json (stateless, no caching needed at this scale).
 */
export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'NanoClaw Management API',
      version: '1.0.0',
      description:
        'REST API for managing NanoClaw groups, sessions, presets, and containers. All write operations update both the in-memory cache and PostgreSQL atomically — no restart required after changes.',
    },
    servers: [{ url: 'http://localhost:3100' }],
  });
}
