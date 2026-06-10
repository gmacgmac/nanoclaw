import { z } from 'zod';
import { ApiErrorSchema } from './common.js';

export const HostCommandEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Command name as the user types it after the leading slash.'),
  description: z
    .string()
    .describe('Human-readable description of what the command does.'),
});

export const HostCommandsResponseSchema = z.object({
  data: z.object({
    gated: z
      .array(HostCommandEntrySchema)
      .describe(
        'Commands that require the group to opt in via containerConfig.allowedHostCommands.',
      ),
    ungated: z
      .array(HostCommandEntrySchema)
      .describe(
        'Commands available to every group with no allowlist entry required.',
      ),
  }),
});

export const HostCommandsNotConfiguredSchema = z.object({
  error: z.string().describe('Human-readable error message'),
  code: z.literal('NOT_CONFIGURED'),
});

// Re-export for convenience
export { ApiErrorSchema };
