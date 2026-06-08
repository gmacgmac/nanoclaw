import { z } from 'zod';

export const ModelCapabilitiesSchema = z.object({
  vision: z.boolean().describe('Whether the model supports image inputs.'),
  thinking: z
    .boolean()
    .optional()
    .describe('Extended thinking / reasoning mode.'),
  tools: z
    .boolean()
    .optional()
    .describe('Native tool/function calling support.'),
  nativeWebTools: z
    .boolean()
    .optional()
    .describe(
      'Provider-hosted WebSearch/WebFetch (Anthropic/Bedrock only). Default false.',
    ),
});

export const ModelPresetInputSchema = z.object({
  endpoint: z.string().min(1).describe('API endpoint URL.'),
  model: z.string().min(1).describe('Model identifier string.'),
  capabilities: ModelCapabilitiesSchema,
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Context window size in tokens. Default: 128000.'),
  compactThreshold: z
    .number()
    .min(0.1)
    .max(0.95)
    .optional()
    .describe(
      'Fraction of context window at which to trigger compaction. Range: 0.1–0.95.',
    ),
  webSearchVendor: z
    .string()
    .optional()
    .describe('Web search vendor key. Default: "ollama".'),
  transform: z
    .enum(['openai'])
    .optional()
    .describe(
      'Request transform to apply. Currently only "openai" is supported.',
    ),
  sdkMode: z
    .enum(['anthropic', 'bedrock'])
    .optional()
    .describe('SDK auth mode. Default: "anthropic".'),
});

export const PresetNameParamSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    .describe('Preset name (alphanumeric, dots, hyphens, underscores).'),
});

export const WriteRawPresetsSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Full JSON content to write to model-presets.json. Must parse as a valid JSON object with valid preset entries.',
    ),
});
