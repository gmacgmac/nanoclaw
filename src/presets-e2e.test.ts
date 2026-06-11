/**
 * End-to-end verification for the nativeWebTools derivation & tool-gating
 * hardening (IMPL_01 + IMPL_02 + IMPL_03).
 *
 * This test exercises the FULL chain for all 10 known presets:
 *   1. validatePresetEntry (host-side derivation from IMPL_01/02)
 *   2. resolveTools mirror (mirrors the agent-runner gate at
 *      container/agent-runner/src/index.ts:589-597)
 *   3. Env-var chain (mirrors container-runner.ts:420-422)
 *
 * For every preset, the test asserts:
 *   - Anthropic presets (3) → nativeWebTools=true → WebSearch in resolved list
 *   - Non-Anthropic presets (7) → nativeWebTools=false → WebSearch NOT in resolved list
 *   - Env var is set (or absent) consistent with the derivation
 *   - The endpoint/vendor mismatch warning fires only for matching misconfig
 */
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

// --- Mirror of the agent-runner gate --------------------------------------
// Mirrors container/agent-runner/src/index.ts:589-597. Identical to the
// resolveTools function in tool-restrictions.test.ts, but scoped to the
// nativeWebTools decision so the end-to-end chain is the focus here.

function resolveWebTools(nativeWebTools: boolean | undefined): {
  hasWebSearch: boolean;
  hasWebFetch: boolean;
  // Mirrors container-runner.ts:420-422: env var is injected iff true
  envVarInjected: boolean;
} {
  const envVarInjected = nativeWebTools === true;
  if (envVarInjected) {
    // WebFetch is NOT in tool-allowlist.json ceiling, only WebSearch is
    return { hasWebSearch: true, hasWebFetch: false, envVarInjected: true };
  }
  return { hasWebSearch: false, hasWebFetch: false, envVarInjected: false };
}

// --- The 10 known presets (per user-confirmed spec) -----------------------
interface PresetSpec {
  name: string;
  endpoint: string;
  model: string;
  webSearchVendor: string;
  expectNative: boolean;
  expectWarn: boolean;
}

const TEN_PRESETS: PresetSpec[] = [
  {
    name: 'OK2.6',
    endpoint: 'ollama',
    model: 'kimi-k2.6:cloud',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'OMM3',
    endpoint: 'ollama',
    model: 'minimax-m3:cloud',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'OGLM5.1',
    endpoint: 'ollama',
    model: 'glm-5.1:cloud',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'ASonnet4.6',
    endpoint: 'anthropic',
    model: 'claude-sonnet-4-6',
    webSearchVendor: 'anthropic',
    expectNative: true,
    expectWarn: false,
  },
  {
    name: 'AOpus4.6',
    endpoint: 'anthropic',
    model: 'claude-opus-4-6',
    webSearchVendor: 'anthropic',
    expectNative: true,
    expectWarn: false,
  },
  {
    name: 'AOpus4.7',
    endpoint: 'anthropic',
    model: 'claude-opus-4-7',
    webSearchVendor: 'anthropic',
    expectNative: true,
    expectWarn: false,
  },
  {
    name: 'BHaiku4.5',
    endpoint: 'bedrock',
    model: 'anthropic.claude-haiku-4-5',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'BKimi2.5',
    endpoint: 'bedrockoss',
    model: 'moonshotai.kimi-k2.5',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'BDeepSeekV3',
    endpoint: 'bedrockoss',
    model: 'deepseek.v3.2',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
  {
    name: 'BSonnet4.6',
    endpoint: 'bedrockrt',
    model: 'us.anthropic.claude-sonnet-4-6',
    webSearchVendor: 'ollama',
    expectNative: false,
    expectWarn: false,
  },
];

function makePresetObject(spec: PresetSpec): unknown {
  return {
    endpoint: spec.endpoint,
    model: spec.model,
    capabilities: { vision: true },
    webSearchVendor: spec.webSearchVendor,
  };
}

describe('E2E: all 10 presets resolve correctly through nativeWebTools chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all 10 presets: validation succeeds', () => {
    for (const spec of TEN_PRESETS) {
      const result = validatePresetEntry(spec.name, makePresetObject(spec));
      expect(result, `preset ${spec.name} should validate`).not.toBeNull();
      expect(result!.endpoint).toBe(spec.endpoint);
      expect(result!.model).toBe(spec.model);
      expect(result!.webSearchVendor).toBe(spec.webSearchVendor);
    }
  });

  it('all 10 presets: nativeWebTools derivation matches expectation', () => {
    for (const spec of TEN_PRESETS) {
      const result = validatePresetEntry(spec.name, makePresetObject(spec));
      expect(result!.capabilities.nativeWebTools).toBe(spec.expectNative);
    }
  });

  it('all 10 presets: 3 Anthropic presets get WebSearch, 7 do not', () => {
    const anthropicPresets = TEN_PRESETS.filter((p) => p.expectNative);
    const nonAnthropicPresets = TEN_PRESETS.filter((p) => !p.expectNative);

    expect(anthropicPresets).toHaveLength(3);
    expect(nonAnthropicPresets).toHaveLength(7);

    for (const spec of anthropicPresets) {
      const result = validatePresetEntry(spec.name, makePresetObject(spec));
      const resolved = resolveWebTools(result!.capabilities.nativeWebTools);
      expect(resolved.hasWebSearch, `${spec.name} should have WebSearch`).toBe(
        true,
      );
    }

    for (const spec of nonAnthropicPresets) {
      const result = validatePresetEntry(spec.name, makePresetObject(spec));
      const resolved = resolveWebTools(result!.capabilities.nativeWebTools);
      expect(
        resolved.hasWebSearch,
        `${spec.name} should NOT have WebSearch`,
      ).toBe(false);
    }
  });

  it('all 10 presets: env-var chain matches derivation (Anthropic=true, else=absent)', () => {
    for (const spec of TEN_PRESETS) {
      const result = validatePresetEntry(spec.name, makePresetObject(spec));
      const resolved = resolveWebTools(result!.capabilities.nativeWebTools);
      // Mirror of container-runner.ts:420-422
      expect(resolved.envVarInjected).toBe(spec.expectNative);
    }
  });

  it('none of the 10 presets trigger the endpoint/vendor mismatch warning', () => {
    // The 10 presets are all consistent: webSearchVendor=anthropic only on
    // anthropic endpoints, webSearchVendor=ollama on all others. This is
    // the "happy path" — no warning should fire for any of them.
    for (const spec of TEN_PRESETS) {
      validatePresetEntry(spec.name, makePresetObject(spec));
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('E2E: warning branch coverage (negative cases)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('webSearchVendor=anthropic on ollama endpoint → endpoint/vendor mismatch warning fires', () => {
    // Confirms the warning branch (IMPL_02) is exercised — even though no
    // shipped preset triggers it, the code path must work.
    const result = validatePresetEntry('mismatch-test', {
      endpoint: 'ollama',
      model: 'some-model',
      capabilities: { vision: true },
      webSearchVendor: 'anthropic',
    });
    expect(result).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: 'mismatch-test',
        webSearchVendor: 'anthropic',
      }),
      expect.stringContaining('webSearchVendor=anthropic'),
    );
  });

  it('explicit nativeWebTools=true on non-anthropic endpoint → IMPL_01 warning fires', () => {
    // Exercises the explicit-override warning branch (IMPL_01).
    const result = validatePresetEntry('forced-bedrockrt', {
      endpoint: 'bedrockrt',
      model: 'some-claude',
      capabilities: { vision: true, nativeWebTools: true },
      webSearchVendor: 'ollama',
    });
    expect(result).not.toBeNull();
    expect(result!.capabilities.nativeWebTools).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: 'forced-bedrockrt',
        endpoint: 'bedrockrt',
      }),
      expect.stringContaining('non-anthropic endpoint'),
    );
  });
});

describe('E2E: explicit-override resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explicit nativeWebTools=false on anthropic endpoint → WebSearch denied despite Anthropic', () => {
    const result = validatePresetEntry('anthropic-disabled', {
      endpoint: 'anthropic',
      model: 'claude-test',
      capabilities: { vision: true, nativeWebTools: false },
      webSearchVendor: 'anthropic',
    });
    expect(result!.capabilities.nativeWebTools).toBe(false);
    const resolved = resolveWebTools(result!.capabilities.nativeWebTools);
    expect(resolved.hasWebSearch).toBe(false);
    expect(resolved.envVarInjected).toBe(false);
    // No warning — explicit opt-out is not a misconfig
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
