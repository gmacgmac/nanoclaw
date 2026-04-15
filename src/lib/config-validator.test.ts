/**
 * BE_09 — containerConfig Validation Tests
 *
 * Tests the validateContainerConfig() function: valid inputs pass through,
 * invalid inputs produce warnings and fall back to secure defaults.
 */

import { describe, it, expect } from 'vitest';
import { validateContainerConfig } from './config-validator.js';
import type { ContainerConfig } from '../types.js';

describe('validateContainerConfig', () => {
  // --- Baseline ---

  it('returns empty config with no warnings for undefined input', () => {
    const result = validateContainerConfig(undefined);
    expect(result.config).toEqual({});
    expect(result.warnings).toHaveLength(0);
  });

  it('passes through a fully valid config unchanged', () => {
    const input: ContainerConfig = {
      injectionScanMode: 'block',
      ssrfProtection: true,
      approvalMode: true,
      approvalTimeout: 60,
      commandAllowlist: ['^git\\b', '^npm\\b'],
      learningLoop: 'extract-only',
      model: 'sonnet',
      timeout: 300000,
    };
    const result = validateContainerConfig(input);
    expect(result.warnings).toHaveLength(0);
    expect(result.config.injectionScanMode).toBe('block');
    expect(result.config.approvalTimeout).toBe(60);
    expect(result.config.commandAllowlist).toEqual(['^git\\b', '^npm\\b']);
    expect(result.config.learningLoop).toBe('extract-only');
  });

  // --- injectionScanMode ---

  it('accepts all valid injectionScanMode values', () => {
    for (const mode of ['off', 'warn', 'block'] as const) {
      const result = validateContainerConfig({ injectionScanMode: mode });
      expect(result.warnings).toHaveLength(0);
      expect(result.config.injectionScanMode).toBe(mode);
    }
  });

  it('rejects invalid injectionScanMode and falls back to warn', () => {
    const result = validateContainerConfig({
      injectionScanMode: 'yolo' as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe('injectionScanMode');
    expect(result.warnings[0].fallback).toBe('warn');
    expect(result.config.injectionScanMode).toBe('warn');
  });

  // --- approvalMode ---

  it('accepts boolean approvalMode', () => {
    expect(
      validateContainerConfig({ approvalMode: true }).warnings,
    ).toHaveLength(0);
    expect(
      validateContainerConfig({ approvalMode: false }).warnings,
    ).toHaveLength(0);
  });

  it('rejects non-boolean approvalMode and falls back to false', () => {
    const result = validateContainerConfig({
      approvalMode: 'manual' as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe('approvalMode');
    expect(result.config.approvalMode).toBe(false);
  });

  // --- approvalTimeout ---

  it('accepts valid approvalTimeout values', () => {
    for (const val of [10, 60, 120, 600]) {
      const result = validateContainerConfig({ approvalTimeout: val });
      expect(result.warnings).toHaveLength(0);
      expect(result.config.approvalTimeout).toBe(val);
    }
  });

  it('rejects approvalTimeout below 10', () => {
    const result = validateContainerConfig({ approvalTimeout: 5 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe('approvalTimeout');
    expect(result.config.approvalTimeout).toBe(120);
  });

  it('rejects approvalTimeout above 600', () => {
    const result = validateContainerConfig({ approvalTimeout: 999 });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.approvalTimeout).toBe(120);
  });

  it('rejects non-number approvalTimeout', () => {
    const result = validateContainerConfig({
      approvalTimeout: '60' as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.approvalTimeout).toBe(120);
  });

  it('rejects NaN approvalTimeout', () => {
    const result = validateContainerConfig({ approvalTimeout: NaN });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.approvalTimeout).toBe(120);
  });

  it('rejects Infinity approvalTimeout', () => {
    const result = validateContainerConfig({ approvalTimeout: Infinity });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.approvalTimeout).toBe(120);
  });

  // --- commandAllowlist ---

  it('accepts valid regex patterns', () => {
    const result = validateContainerConfig({
      commandAllowlist: ['^git\\b', '^npm run test$'],
    });
    expect(result.warnings).toHaveLength(0);
    expect(result.config.commandAllowlist).toEqual([
      '^git\\b',
      '^npm run test$',
    ]);
  });

  it('filters out invalid regex patterns with warnings', () => {
    const result = validateContainerConfig({
      commandAllowlist: ['^git\\b', '[invalid(', '^npm\\b'],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('[invalid(');
    expect(result.config.commandAllowlist).toEqual(['^git\\b', '^npm\\b']);
  });

  it('filters out non-string entries with warnings', () => {
    const result = validateContainerConfig({
      commandAllowlist: ['^git\\b', 42 as any, null as any],
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.config.commandAllowlist).toEqual(['^git\\b']);
  });

  it('rejects non-array commandAllowlist', () => {
    const result = validateContainerConfig({
      commandAllowlist: 'not-an-array' as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.commandAllowlist).toEqual([]);
  });

  it('accepts empty commandAllowlist', () => {
    const result = validateContainerConfig({ commandAllowlist: [] });
    expect(result.warnings).toHaveLength(0);
    expect(result.config.commandAllowlist).toEqual([]);
  });

  // --- learningLoop ---

  it('accepts all valid learningLoop values', () => {
    for (const val of [true, false, 'extract-only'] as const) {
      const result = validateContainerConfig({ learningLoop: val });
      expect(result.warnings).toHaveLength(0);
      expect(result.config.learningLoop).toBe(val);
    }
  });

  it('rejects invalid learningLoop and falls back to false', () => {
    const result = validateContainerConfig({
      learningLoop: 'always' as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.learningLoop).toBe(false);
  });

  // --- ssrfProtection ---

  it('accepts boolean ssrfProtection', () => {
    expect(
      validateContainerConfig({ ssrfProtection: true }).warnings,
    ).toHaveLength(0);
    expect(
      validateContainerConfig({ ssrfProtection: false }).warnings,
    ).toHaveLength(0);
  });

  it('accepts valid SsrfConfig object', () => {
    const result = validateContainerConfig({
      ssrfProtection: { allowPrivateNetworks: true },
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('accepts SsrfConfig with additional host lists', () => {
    const result = validateContainerConfig({
      ssrfProtection: {
        allowPrivateNetworks: false,
        additionalBlockedHosts: ['evil.com'],
        additionalAllowedHosts: ['internal.corp'],
      },
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects SsrfConfig with non-boolean allowPrivateNetworks', () => {
    const result = validateContainerConfig({
      ssrfProtection: { allowPrivateNetworks: 'yes' as any },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.ssrfProtection).toBe(true);
  });

  it('rejects non-boolean non-object ssrfProtection', () => {
    const result = validateContainerConfig({
      ssrfProtection: 42 as any,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.config.ssrfProtection).toBe(true);
  });

  // --- Multiple invalid fields ---

  it('reports multiple warnings for multiple invalid fields', () => {
    const result = validateContainerConfig({
      injectionScanMode: 'invalid' as any,
      approvalTimeout: -1,
      learningLoop: 'nope' as any,
    });
    expect(result.warnings).toHaveLength(3);
    const fields = result.warnings.map((w) => w.field).sort();
    expect(fields).toEqual([
      'approvalTimeout',
      'injectionScanMode',
      'learningLoop',
    ]);
  });

  // --- Backward compatibility ---

  it('absent fields are not added to config (no defaults injected)', () => {
    const result = validateContainerConfig({});
    expect(result.config.injectionScanMode).toBeUndefined();
    expect(result.config.approvalMode).toBeUndefined();
    expect(result.config.approvalTimeout).toBeUndefined();
    expect(result.config.commandAllowlist).toBeUndefined();
    expect(result.config.learningLoop).toBeUndefined();
    expect(result.config.ssrfProtection).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it('non-security fields pass through untouched', () => {
    const input: ContainerConfig = {
      model: 'opus',
      timeout: 600000,
      endpoint: 'ollama',
      skills: ['status'],
      allowedTools: ['Read', 'Write'],
    };
    const result = validateContainerConfig(input);
    expect(result.warnings).toHaveLength(0);
    expect(result.config.model).toBe('opus');
    expect(result.config.timeout).toBe(600000);
    expect(result.config.endpoint).toBe('ollama');
    expect(result.config.skills).toEqual(['status']);
    expect(result.config.allowedTools).toEqual(['Read', 'Write']);
  });
});

// --- Env var pipeline tests ---
// Replicates the logic from buildContainerArgs and execute_command
// to verify the full config → env var → consumer chain.

describe('approval env var pipeline', () => {
  /**
   * Replicates buildContainerArgs approval env var logic.
   * Returns the env vars that would be set.
   */
  function buildApprovalEnvVars(
    config: ContainerConfig,
  ): Record<string, string> {
    const envVars: Record<string, string> = {};
    if (config.approvalMode !== true) return envVars;

    envVars['NANOCLAW_APPROVAL_MODE'] = 'true';

    const rawTimeout = config.approvalTimeout;
    const approvalTimeout =
      typeof rawTimeout === 'number' && rawTimeout >= 10 && rawTimeout <= 600
        ? rawTimeout
        : 120;
    envVars['NANOCLAW_APPROVAL_TIMEOUT'] = String(approvalTimeout);

    const allowlist = config.commandAllowlist;
    if (Array.isArray(allowlist) && allowlist.length > 0) {
      envVars['NANOCLAW_COMMAND_ALLOWLIST'] = JSON.stringify(allowlist);
    }

    return envVars;
  }

  /**
   * Replicates execute_command's env var parsing for timeout.
   */
  function parseApprovalTimeout(envValue: string | undefined): number {
    const envTimeout = parseInt(envValue || '', 10);
    return envTimeout >= 10 && envTimeout <= 600 ? envTimeout : 120;
  }

  /**
   * Replicates execute_command's env var parsing for allowlist.
   */
  function parseCommandAllowlist(envValue: string | undefined): RegExp[] {
    if (!envValue) return [];
    try {
      const patterns: string[] = JSON.parse(envValue);
      return patterns
        .filter((p) => typeof p === 'string' && p.length > 0)
        .map((p) => {
          try {
            return new RegExp(p);
          } catch {
            return null;
          }
        })
        .filter((r): r is RegExp => r !== null);
    } catch {
      return [];
    }
  }

  it('approvalMode: false → no env vars set', () => {
    const envVars = buildApprovalEnvVars({ approvalMode: false });
    expect(envVars).toEqual({});
  });

  it('approvalMode: true → sets NANOCLAW_APPROVAL_MODE', () => {
    const envVars = buildApprovalEnvVars({ approvalMode: true });
    expect(envVars['NANOCLAW_APPROVAL_MODE']).toBe('true');
  });

  it('approvalTimeout flows through env var correctly', () => {
    const envVars = buildApprovalEnvVars({
      approvalMode: true,
      approvalTimeout: 300,
    });
    expect(envVars['NANOCLAW_APPROVAL_TIMEOUT']).toBe('300');

    // Consumer side
    const parsed = parseApprovalTimeout(envVars['NANOCLAW_APPROVAL_TIMEOUT']);
    expect(parsed).toBe(300);
  });

  it('missing approvalTimeout defaults to 120 on both sides', () => {
    const envVars = buildApprovalEnvVars({ approvalMode: true });
    expect(envVars['NANOCLAW_APPROVAL_TIMEOUT']).toBe('120');

    const parsed = parseApprovalTimeout(envVars['NANOCLAW_APPROVAL_TIMEOUT']);
    expect(parsed).toBe(120);
  });

  it('invalid approvalTimeout defaults to 120 on host side', () => {
    const envVars = buildApprovalEnvVars({
      approvalMode: true,
      approvalTimeout: 9999,
    });
    expect(envVars['NANOCLAW_APPROVAL_TIMEOUT']).toBe('120');
  });

  it('commandAllowlist flows through env var correctly', () => {
    const envVars = buildApprovalEnvVars({
      approvalMode: true,
      commandAllowlist: ['^git\\b', '^npm run test$'],
    });
    expect(envVars['NANOCLAW_COMMAND_ALLOWLIST']).toBeDefined();

    // Consumer side
    const regexes = parseCommandAllowlist(
      envVars['NANOCLAW_COMMAND_ALLOWLIST'],
    );
    expect(regexes).toHaveLength(2);
    expect(regexes[0].test('git status')).toBe(true);
    expect(regexes[0].test('rm -rf /')).toBe(false);
    expect(regexes[1].test('npm run test')).toBe(true);
    expect(regexes[1].test('npm run build')).toBe(false);
  });

  it('empty commandAllowlist → no env var set', () => {
    const envVars = buildApprovalEnvVars({
      approvalMode: true,
      commandAllowlist: [],
    });
    expect(envVars['NANOCLAW_COMMAND_ALLOWLIST']).toBeUndefined();
  });

  it('malformed NANOCLAW_COMMAND_ALLOWLIST → empty array (fail-safe)', () => {
    const regexes = parseCommandAllowlist('not-json');
    expect(regexes).toEqual([]);
  });

  it('absent NANOCLAW_COMMAND_ALLOWLIST → empty array', () => {
    const regexes = parseCommandAllowlist(undefined);
    expect(regexes).toEqual([]);
  });

  it('allowlisted command skips approval (end-to-end)', () => {
    // Simulate the full flow: config → validate → env vars → consumer
    const rawConfig: ContainerConfig = {
      approvalMode: true,
      approvalTimeout: 60,
      commandAllowlist: ['^git\\b'],
    };

    // Step 1: Validate
    const { config } = validateContainerConfig(rawConfig);

    // Step 2: Build env vars
    const envVars = buildApprovalEnvVars(config);

    // Step 3: Parse on consumer side
    const allowlist = parseCommandAllowlist(
      envVars['NANOCLAW_COMMAND_ALLOWLIST'],
    );

    // Step 4: Check if command is allowlisted
    const isAllowlisted = allowlist.some((re) =>
      re.test('git push origin main'),
    );
    expect(isAllowlisted).toBe(true);

    const isDangerous = allowlist.some((re) =>
      re.test('rm -rf /workspace/extra/data'),
    );
    expect(isDangerous).toBe(false);
  });
});
