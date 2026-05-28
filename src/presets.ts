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
}

export interface ModelPreset {
  endpoint: string;
  model: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  compactThreshold?: number;
  webSearchVendor?: string;
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
  };
}

function validatePresetEntry(key: string, value: unknown): ModelPreset | null {
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

  const capabilities = validateCapabilities(obj.capabilities, key);
  if (!capabilities) return null;

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

  const webSearchVendor =
    typeof obj.webSearchVendor === 'string' && obj.webSearchVendor
      ? obj.webSearchVendor
      : DEFAULT_WEB_SEARCH_VENDOR;

  return {
    endpoint: obj.endpoint,
    model: obj.model,
    capabilities,
    contextWindow,
    ...(compactThreshold !== undefined && { compactThreshold }),
    webSearchVendor,
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
