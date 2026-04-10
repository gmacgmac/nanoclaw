/**
 * BE_02: SSRF Integration Tests
 *
 * Tests the SSRF protection wiring:
 * 1. Config parsing (NANOCLAW_SSRF_CONFIG env var → SsrfConfig)
 * 2. Validator gating in proxyWebFetch context
 * 3. containerConfig.ssrfProtection → env var mapping
 *
 * The validator itself is exhaustively tested in ssrf-validator.test.ts (BE_01).
 * These tests focus on the integration layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateUrl } from './ssrf-validator.js';

// --- Config parsing tests (mirrors MCP server's parseSsrfConfig) ---

interface SsrfConfig {
  enabled: boolean;
  allowPrivateNetworks?: boolean;
}

/** Replicates the MCP server's parseSsrfConfig for testability */
function parseSsrfConfig(envValue: string | undefined): SsrfConfig {
  if (!envValue) return { enabled: true };
  try {
    const parsed = JSON.parse(envValue) as Partial<SsrfConfig>;
    return {
      enabled: parsed.enabled !== false,
      allowPrivateNetworks: parsed.allowPrivateNetworks === true,
    };
  } catch {
    return { enabled: true };
  }
}

/** Replicates container-runner's ssrfProtection → env var mapping */
function buildSsrfConfigEnv(
  ssrfProtection: boolean | { allowPrivateNetworks: boolean } | undefined,
): string {
  const ssrfEnabled = ssrfProtection !== false;
  const ssrfAllowPrivate =
    typeof ssrfProtection === 'object' &&
    ssrfProtection?.allowPrivateNetworks === true;
  return JSON.stringify({
    enabled: ssrfEnabled,
    ...(ssrfAllowPrivate && { allowPrivateNetworks: true }),
  });
}

// --- Mock DNS for validator tests ---

vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'dns/promises';
const mockLookup = vi.mocked(lookup);

function dnsResolves(ip: string) {
  mockLookup.mockResolvedValue({ address: ip, family: 4 });
}

function dnsFails() {
  mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
}

describe('SSRF Config Parsing (parseSsrfConfig)', () => {
  it('defaults to enabled when env var is absent', () => {
    expect(parseSsrfConfig(undefined)).toEqual({ enabled: true });
  });

  it('defaults to enabled when env var is empty string', () => {
    expect(parseSsrfConfig('')).toEqual({ enabled: true });
  });

  it('defaults to enabled when env var is invalid JSON', () => {
    expect(parseSsrfConfig('not-json')).toEqual({ enabled: true });
  });

  it('parses enabled: true', () => {
    expect(parseSsrfConfig('{"enabled":true}')).toEqual({
      enabled: true,
      allowPrivateNetworks: false,
    });
  });

  it('parses enabled: false', () => {
    expect(parseSsrfConfig('{"enabled":false}')).toEqual({
      enabled: false,
      allowPrivateNetworks: false,
    });
  });

  it('parses allowPrivateNetworks: true', () => {
    expect(
      parseSsrfConfig('{"enabled":true,"allowPrivateNetworks":true}'),
    ).toEqual({
      enabled: true,
      allowPrivateNetworks: true,
    });
  });

  it('ignores unknown fields', () => {
    expect(parseSsrfConfig('{"enabled":true,"foo":"bar"}')).toEqual({
      enabled: true,
      allowPrivateNetworks: false,
    });
  });
});

describe('containerConfig.ssrfProtection → env var mapping', () => {
  it('undefined → enabled (secure by default)', () => {
    const json = buildSsrfConfigEnv(undefined);
    const config = parseSsrfConfig(json);
    expect(config.enabled).toBe(true);
  });

  it('false → disabled', () => {
    const json = buildSsrfConfigEnv(false);
    const config = parseSsrfConfig(json);
    expect(config.enabled).toBe(false);
  });

  it('true → enabled', () => {
    const json = buildSsrfConfigEnv(true);
    const config = parseSsrfConfig(json);
    expect(config.enabled).toBe(true);
  });

  it('{ allowPrivateNetworks: true } → enabled with private networks allowed', () => {
    const json = buildSsrfConfigEnv({ allowPrivateNetworks: true });
    const config = parseSsrfConfig(json);
    expect(config.enabled).toBe(true);
    expect(config.allowPrivateNetworks).toBe(true);
  });

  it('{ allowPrivateNetworks: false } → enabled, private networks blocked', () => {
    const json = buildSsrfConfigEnv({ allowPrivateNetworks: false });
    const config = parseSsrfConfig(json);
    expect(config.enabled).toBe(true);
    expect(config.allowPrivateNetworks).toBeFalsy();
  });
});

describe('SSRF gating in proxyWebFetch context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('blocks metadata endpoint (169.254.169.254)', async () => {
    const result = await validateUrl(
      'http://169.254.169.254/latest/meta-data/',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('link-local');
  });

  it('blocks private network (192.168.1.1)', async () => {
    const result = await validateUrl('http://192.168.1.1/admin');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private');
  });

  it('blocks loopback (127.0.0.1)', async () => {
    const result = await validateUrl('http://127.0.0.1:8080/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('loopback');
  });

  it('allows public URL', async () => {
    dnsResolves('93.184.216.34'); // example.com
    const result = await validateUrl('https://example.com/page');
    expect(result.allowed).toBe(true);
  });

  it('allows private network when allowPrivateNetworks is true', async () => {
    const result = await validateUrl('http://192.168.1.1/admin', {
      allowPrivateNetworks: true,
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks file:// scheme', async () => {
    const result = await validateUrl('file:///etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Blocked scheme');
  });

  it('blocks when DNS resolves to private IP', async () => {
    dnsResolves('10.0.0.1');
    const result = await validateUrl('https://evil.example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Resolved IP in blocked range');
  });

  it('blocks on DNS failure (fail-closed)', async () => {
    dnsFails();
    const result = await validateUrl('https://nonexistent.example.com/');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DNS resolution failed');
  });

  it('blocks cloud metadata hostname', async () => {
    const result = await validateUrl(
      'http://metadata.google.internal/computeMetadata/v1/',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cloud metadata');
  });
});

describe('End-to-end: containerConfig → config parsing → validator behavior', () => {
  it('default config blocks metadata', async () => {
    // Simulate: containerConfig.ssrfProtection is undefined (default)
    const envJson = buildSsrfConfigEnv(undefined);
    const config = parseSsrfConfig(envJson);

    expect(config.enabled).toBe(true);

    // When enabled, validator should block metadata
    const result = await validateUrl('http://169.254.169.254/');
    expect(result.allowed).toBe(false);
  });

  it('disabled config would skip validation', () => {
    // Simulate: containerConfig.ssrfProtection = false
    const envJson = buildSsrfConfigEnv(false);
    const config = parseSsrfConfig(envJson);

    expect(config.enabled).toBe(false);
    // When disabled, the MCP server skips validateUrl() entirely
  });

  it('allowPrivateNetworks config passes through correctly', async () => {
    const envJson = buildSsrfConfigEnv({ allowPrivateNetworks: true });
    const config = parseSsrfConfig(envJson);

    expect(config.enabled).toBe(true);
    expect(config.allowPrivateNetworks).toBe(true);

    // With allowPrivateNetworks, private IPs should be allowed
    const result = await validateUrl('http://192.168.1.1/', {
      allowPrivateNetworks: config.allowPrivateNetworks,
    });
    expect(result.allowed).toBe(true);
  });

  it('allowPrivateNetworks still blocks metadata hostnames', async () => {
    const envJson = buildSsrfConfigEnv({ allowPrivateNetworks: true });
    const config = parseSsrfConfig(envJson);

    // metadata.google.internal is blocked by hostname, not by IP range
    const result = await validateUrl('http://metadata.google.internal/', {
      allowPrivateNetworks: config.allowPrivateNetworks,
    });
    expect(result.allowed).toBe(false);
  });
});
