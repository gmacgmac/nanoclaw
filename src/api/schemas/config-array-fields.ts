import { z } from 'zod';
import { McpServerSchema } from './container-config.js';
import { ApiErrorSchema } from './common.js';

// --- String-array fields (skills, hooks, allowedHostCommands, deniedTools, commandAllowlist) ---

export const StringArrayPatchSchema = z
  .object({
    add: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Items to append. Duplicates against the current value are silently dropped. Empty strings rejected.',
      ),
    remove: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Items to remove. Absent items are silently skipped (idempotent). Empty strings rejected.',
      ),
  })
  .refine((v) => v.add !== undefined || v.remove !== undefined, {
    message: 'At least one of `add` or `remove` must be provided.',
  })
  .describe(
    'Add and/or remove items from a string-array config field. ' +
      'Idempotent: adding an existing item or removing an absent item is a no-op, never an error.',
  );

export const StringArrayPutSchema = z
  .object({
    value: z
      .array(z.string().min(1))
      .describe(
        'Replacement value for the entire field. Empty strings rejected. ' +
          'For per-field validation (e.g. unknown skill name), the server returns 400.',
      ),
  })
  .describe('Replace the entire string-array config field with `value`.');

// --- Map field (mcpServers) ---

export const McpServersPatchSchema = z
  .object({
    add: z
      .record(z.string().min(1), McpServerSchema)
      .optional()
      .describe(
        'Servers to merge into the current map. Keys overwrite existing entries of the same name.',
      ),
    remove: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Server names to delete. Absent names are silently skipped (idempotent).',
      ),
  })
  .refine((v) => v.add !== undefined || v.remove !== undefined, {
    message: 'At least one of `add` or `remove` must be provided.',
  })
  .describe(
    'Add and/or remove entries in the mcpServers map. ' +
      'Idempotent: adding an existing key overwrites it; removing an absent key is a no-op.',
  );

export const McpServersPutSchema = z
  .object({
    value: z
      .record(z.string().min(1), McpServerSchema)
      .describe('Replacement map for the entire mcpServers field.'),
  })
  .describe('Replace the entire mcpServers map with `value`.');

// --- Generic response wrapper ---
// Returned by GET/PATCH/PUT for all field endpoints. The `data` object has exactly
// one key: the config key for the field. We can't be type-exact across all 6 fields
// without a generic schema, so this is a loose Record — Zod's .openapi() accepts
// any additional properties. The route handler always returns a single key.

export const FieldValueResponseSchema = z
  .object({ data: z.record(z.string(), z.unknown()) })
  .describe(
    'Response wrapper for field endpoints. `data` contains exactly one key: the ' +
      'config field name. Value shape depends on the field (string[] or map).',
  );

// Re-export for convenience so route file can import from one place
export { ApiErrorSchema };
