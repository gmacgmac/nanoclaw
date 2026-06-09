import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import {
  ContainerConfigSchema,
  RegisteredGroupSchema,
  CreateGroupSchema,
  UpdateGroupSchema,
  PatchConfigSchema,
  SwitchPresetSchema,
  ApiErrorSchema,
  ModelCapabilitiesSchema,
  ModelPresetInputSchema,
  WriteRawPresetsSchema,
} from './schemas/index.js';

export const registry = new OpenAPIRegistry();

// Register reusable schemas as components. Path registrations happen at import
// time in each route file via `defineRoute` (see ./lib/route-builder.ts), which
// also imports `registry` from this module.
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
