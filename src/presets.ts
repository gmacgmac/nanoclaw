/**
 * Presets module — single entry point for loading, validating, and resolving
 * model presets from ~/.config/nanoclaw/model-presets.json.
 */

import fs from 'fs';
import path from 'path';

import { HOME_DIR } from './config.js';
import { logger } from './logger.js';

// --- Types ---

export interface ModelCapabilities {
  vision: boolean;
  thinking?: boolean;
  tools?: boolean;
  /**
   * Native WebSearch/WebFetch execute server-side at the provider
   * (Anthropic/Bedrock-hosted Claude). Default false — non-Anthropic
   * endpoints must use the nanoclaw-web-search MCP.
   */
  nativeWebTools?: boolean;
}

export type TransformName = 'openai';

const VALID_TRANSFORMS: readonly TransformName[] = ['openai'];

export type SdkMode = 'anthropic' | 'bedrock';

const VALID_SDK_MODES: readonly SdkMode[] = ['anthropic', 'bedrock'];

export interface ModelPreset {
  endpoint: string;
  model: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  compactThreshold?: number;
  webSearchVendor?: string;
  transform?: TransformName;
  sdkMode?: SdkMode;
}

export interface ResolvedPreset extends ModelPreset {
  name: string;
}

// --- Constants ---

export const PRESETS_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'model-presets.json',
);

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_WEB_SEARCH_VENDOR = 'ollama';

// --- Validation ---

function validateCapabilities(
  value: unknown,
  presetName: string,
  endpoint: string,
): ModelCapabilities | null {
  if (typeof value !== 'object' || value === null) {
    logger.warn(
      { preset: presetName },
      'Preset missing or invalid capabilities object',
    );
    return null;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.vision !== 'boolean') {
    logger.warn(
      { preset: presetName },
      'Preset capabilities.vision must be a boolean',
    );
    return null;
  }

  return {
    vision: obj.vision,
    thinking: typeof obj.thinking === 'boolean' ? obj.thinking : undefined,
    tools: typeof obj.tools === 'boolean' ? obj.tools : undefined,
    nativeWebTools:
      typeof obj.nativeWebTools === 'boolean'
        ? obj.nativeWebTools
        : endpoint === 'anthropic',
  };
}

export function validatePresetEntry(
  key: string,
  value: unknown,
): ModelPreset | null {
  if (typeof value !== 'object' || value === null) {
    logger.warn({ preset: key }, 'Skipping invalid model preset entry');
    return null;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.endpoint !== 'string' || !obj.endpoint) {
    logger.warn(
      { preset: key },
      'Preset missing required string field: endpoint',
    );
    return null;
  }

  if (typeof obj.model !== 'string' || !obj.model) {
    logger.warn({ preset: key }, 'Preset missing required string field: model');
    return null;
  }

  const capabilities = validateCapabilities(
    obj.capabilities,
    key,
    obj.endpoint,
  );
  if (!capabilities) return null;

  const webSearchVendor =
    typeof obj.webSearchVendor === 'string' && obj.webSearchVendor
      ? obj.webSearchVendor
      : DEFAULT_WEB_SEARCH_VENDOR;

  if (capabilities.nativeWebTools === true && obj.endpoint !== 'anthropic') {
    logger.warn(
      {
        preset: key,
        endpoint: obj.endpoint,
        webSearchVendor,
      },
      'nativeWebTools=true on non-anthropic endpoint — Anthropic WebSearch may not be supported on this route',
    );
  }

  if (webSearchVendor === 'anthropic' && obj.endpoint !== 'anthropic') {
    logger.warn(
      {
        preset: key,
        endpoint: obj.endpoint,
        webSearchVendor,
      },
      'webSearchVendor=anthropic on non-anthropic endpoint — MCP web search will route to Anthropic',
    );
  }

  const contextWindow =
    typeof obj.contextWindow === 'number' && obj.contextWindow > 0
      ? obj.contextWindow
      : DEFAULT_CONTEXT_WINDOW;

  const compactThreshold =
    typeof obj.compactThreshold === 'number' &&
    obj.compactThreshold >= 0.1 &&
    obj.compactThreshold <= 0.95
      ? obj.compactThreshold
      : undefined;

  let transform: TransformName | undefined;
  if (obj.transform !== undefined) {
    if (
      typeof obj.transform === 'string' &&
      VALID_TRANSFORMS.includes(obj.transform as TransformName)
    ) {
      transform = obj.transform as TransformName;
    } else {
      logger.warn(
        { preset: key, transform: obj.transform },
        'Invalid transform; ignoring (passthrough)',
      );
    }
  }

  let sdkMode: SdkMode | undefined;
  if (obj.sdkMode !== undefined) {
    if (
      typeof obj.sdkMode === 'string' &&
      VALID_SDK_MODES.includes(obj.sdkMode as SdkMode)
    ) {
      sdkMode = obj.sdkMode as SdkMode;
    } else {
      logger.warn(
        { preset: key, sdkMode: obj.sdkMode },
        'Invalid sdkMode; ignoring (defaults to anthropic)',
      );
    }
  }

  return {
    endpoint: obj.endpoint,
    model: obj.model,
    capabilities,
    contextWindow,
    ...(compactThreshold !== undefined && { compactThreshold }),
    webSearchVendor,
    ...(transform !== undefined && { transform }),
    ...(sdkMode !== undefined && { sdkMode }),
  };
}

// --- Public API ---

/**
 * Load and validate all presets from model-presets.json.
 * Returns empty object if file is missing or unreadable.
 * Skips invalid entries with warnings.
 */
export function loadPresets(): Record<string, ModelPreset> {
  try {
    const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      logger.warn(
        { path: PRESETS_PATH },
        'model-presets.json is not an object',
      );
      return {};
    }

    const presets: Record<string, ModelPreset> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const validated = validatePresetEntry(key, value);
      if (validated) {
        presets[key] = validated;
      }
    }
    return presets;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn({ path: PRESETS_PATH }, 'model-presets.json not found');
    } else {
      logger.warn(
        { err, path: PRESETS_PATH },
        'Failed to load model-presets.json',
      );
    }
    return {};
  }
}

/**
 * Resolve a preset by name. Returns null if name is undefined or not found.
 */
export function resolvePreset(name: string | undefined): ResolvedPreset | null {
  if (!name) return null;

  const presets = loadPresets();
  const preset = presets[name];
  if (!preset) return null;

  return { ...preset, name };
}

/**
 * Returns a sorted list of all valid preset names.
 */
export function getAvailablePresetNames(): string[] {
  const presets = loadPresets();
  return Object.keys(presets).sort();
}

/**
 * Reverse lookup: find the preset name that matches a given endpoint+model pair.
 * Used by the migration to map existing groups to preset names.
 * Returns undefined if no match found.
 */
export function findPresetByModelEndpoint(
  endpoint: string,
  model: string,
): string | undefined {
  const presets = loadPresets();
  for (const [name, preset] of Object.entries(presets)) {
    if (preset.endpoint === endpoint && preset.model === model) {
      return name;
    }
  }
  return undefined;
}

// --- Health / Raw / Write API ---

export interface PresetsHealth {
  healthy: boolean;
  count: number;
  error?: string;
  parseError?: string;
}

export function getPresetsHealth(): PresetsHealth {
  let raw: string;
  try {
    raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { healthy: true, count: 0 };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      healthy: false,
      count: 0,
      error: 'model-presets.json failed to parse',
      parseError: message,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      healthy: false,
      count: 0,
      error: 'model-presets.json is not an object',
    };
  }

  let count = 0;
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (validatePresetEntry(key, value)) count++;
  }
  return { healthy: true, count };
}

export function readRawPresets(): { exists: boolean; content: string } {
  try {
    const content = fs.readFileSync(PRESETS_PATH, 'utf-8');
    return { exists: true, content };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, content: '' };
    }
    throw err;
  }
}

export function writePresets(presets: Record<string, ModelPreset>): void {
  fs.mkdirSync(path.dirname(PRESETS_PATH), { recursive: true });
  const tmpPath = `${PRESETS_PATH}.tmp`;
  const serialized = JSON.stringify(presets, null, 2);
  fs.writeFileSync(tmpPath, serialized, 'utf-8');
  fs.renameSync(tmpPath, PRESETS_PATH);
  logger.info(
    { path: PRESETS_PATH, count: Object.keys(presets).length },
    'model-presets.json written',
  );
}

export interface WriteRawResult {
  ok: boolean;
  error?: string;
  validCount?: number;
  invalidKeys?: string[];
}

export function writeRawPresets(raw: string): WriteRawResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'Invalid JSON: ' + message };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Content must be a JSON object' };
  }

  const validPresets: Record<string, ModelPreset> = {};
  const invalidKeys: string[] = [];
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const validated = validatePresetEntry(key, value);
    if (validated) {
      validPresets[key] = validated;
    } else {
      invalidKeys.push(key);
    }
  }

  const originalHadEntries =
    Object.keys(parsed as Record<string, unknown>).length > 0;
  if (Object.keys(validPresets).length === 0 && originalHadEntries) {
    return {
      ok: false,
      error: 'No valid preset entries found',
      invalidKeys,
    };
  }

  writePresets(validPresets);
  return {
    ok: true,
    validCount: Object.keys(validPresets).length,
    invalidKeys,
  };
}

export interface UpsertPresetResult {
  ok: boolean;
  error?: string;
  code?: 'PRESETS_CORRUPT' | 'VALIDATION_ERROR';
}

export function upsertPreset(
  name: string,
  preset: ModelPreset,
): UpsertPresetResult {
  let currentPresets: Record<string, ModelPreset> = {};
  try {
    const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error:
          'model-presets.json is corrupt — use PUT /api/presets/raw to repair',
        code: 'PRESETS_CORRUPT',
      };
    }
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const validated = validatePresetEntry(key, value);
      if (validated) currentPresets[key] = validated;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        error:
          'model-presets.json is corrupt — use PUT /api/presets/raw to repair',
        code: 'PRESETS_CORRUPT',
      };
    }
  }

  currentPresets[name] = preset;
  writePresets(currentPresets);
  return { ok: true };
}

export interface DeletePresetResult {
  ok: boolean;
  found: boolean;
  error?: string;
  code?: 'PRESETS_CORRUPT';
}

export function deletePreset(name: string): DeletePresetResult {
  let currentPresets: Record<string, ModelPreset> = {};
  try {
    const raw = fs.readFileSync(PRESETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        found: false,
        error:
          'model-presets.json is corrupt — use PUT /api/presets/raw to repair',
        code: 'PRESETS_CORRUPT',
      };
    }
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const validated = validatePresetEntry(key, value);
      if (validated) currentPresets[key] = validated;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        found: false,
        error:
          'model-presets.json is corrupt — use PUT /api/presets/raw to repair',
        code: 'PRESETS_CORRUPT',
      };
    }
  }

  if (!(name in currentPresets)) {
    return { ok: true, found: false };
  }

  delete currentPresets[name];
  writePresets(currentPresets);
  return { ok: true, found: true };
}
