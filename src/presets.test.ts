import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  log: { error: vi.fn(), fatal: vi.fn() },
}));

import { logger } from './logger.js';
import { validatePresetEntry } from './presets.js';

function makePreset(overrides: Record<string, unknown> = {}): unknown {
  return {
    endpoint: 'anthropic',
    model: 'claude-test',
    capabilities: { vision: true },
    ...overrides,
  };
}

describe('validatePresetEntry — nativeWebTools derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives nativeWebTools=true when endpoint is anthropic and field is absent', () => {
    const result = validatePresetEntry('anthropic-preset', makePreset());
    expect(result?.capabilities.nativeWebTools).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('derives nativeWebTools=false when endpoint is ollama and field is absent', () => {
    const result = validatePresetEntry(
      'ollama-preset',
      makePreset({ endpoint: 'ollama' }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('derives nativeWebTools=false when endpoint is bedrock and field is absent', () => {
    const result = validatePresetEntry(
      'bedrock-preset',
      makePreset({ endpoint: 'bedrock' }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('derives nativeWebTools=false when endpoint is bedrockrt and field is absent', () => {
    const result = validatePresetEntry(
      'bedrockrt-preset',
      makePreset({ endpoint: 'bedrockrt' }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('derives nativeWebTools=false when endpoint is bedrockoss and field is absent', () => {
    const result = validatePresetEntry(
      'bedrockoss-preset',
      makePreset({ endpoint: 'bedrockoss' }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('respects explicit nativeWebTools=false on anthropic endpoint', () => {
    const result = validatePresetEntry(
      'anthropic-disabled',
      makePreset({
        capabilities: { vision: true, nativeWebTools: false },
      }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('respects explicit nativeWebTools=true on non-anthropic endpoint and warns', () => {
    const result = validatePresetEntry(
      'bedrockrt-forced',
      makePreset({
        endpoint: 'bedrockrt',
        capabilities: { vision: true, nativeWebTools: true },
      }),
    );
    expect(result?.capabilities.nativeWebTools).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: 'bedrockrt-forced',
        endpoint: 'bedrockrt',
      }),
      expect.stringContaining('non-anthropic endpoint'),
    );
  });
});

describe('validatePresetEntry — webSearchVendor/endpoint consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns when webSearchVendor=anthropic on non-anthropic endpoint', () => {
    const result = validatePresetEntry(
      'ollama-anthropic-vendor',
      makePreset({ endpoint: 'ollama', webSearchVendor: 'anthropic' }),
    );
    expect(result).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: 'ollama-anthropic-vendor',
        endpoint: 'ollama',
        webSearchVendor: 'anthropic',
      }),
      expect.stringContaining('webSearchVendor=anthropic'),
    );
  });

  it('does not warn when webSearchVendor=anthropic matches anthropic endpoint', () => {
    const result = validatePresetEntry(
      'anthropic-anthropic-vendor',
      makePreset({ endpoint: 'anthropic', webSearchVendor: 'anthropic' }),
    );
    expect(result).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when webSearchVendor=ollama on non-anthropic endpoint', () => {
    const result = validatePresetEntry(
      'ollama-ollama-vendor',
      makePreset({ endpoint: 'ollama', webSearchVendor: 'ollama' }),
    );
    expect(result).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
