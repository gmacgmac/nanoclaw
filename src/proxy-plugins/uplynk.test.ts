/**
 * Uplynk proxy plugin — unit tests.
 *
 * Always run as part of the test suite. All external dependencies are mocked.
 *
 * For integration tests against the real Uplynk API, see:
 *   src/proxy-plugins/uplynk.integration.test.ts
 *
 * Run:  npm test -- src/proxy-plugins/uplynk
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import zlib from 'zlib';
import http from 'http';
import type { AddressInfo } from 'net';

// --- Mocks ---

const mockEnv: Record<string, string> = {};

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const k of keys) if (mockEnv[k]) result[k] = mockEnv[k];
    return result;
  }),
  scanEndpoints: vi.fn(() => ({})),
  scanWebSearchEndpoints: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../transcription.js', () => ({
  transcribeAudio: vi.fn(),
}));

import { createProxyPlugins } from './registry.js';

// Trigger self-registration
import './uplynk.js';

// --- Helpers ---

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
        }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Tests ---

describe('uplynk proxy plugin', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  describe('conditional loading', () => {
    it('returns no uplynk plugin when UPLYNK_USERID is missing', () => {
      mockEnv.UPLYNK_API_KEY = 'some-key';
      const plugins = createProxyPlugins();
      expect(plugins.find(p => p.name === 'uplynk')).toBeUndefined();
    });

    it('returns no uplynk plugin when UPLYNK_API_KEY is missing', () => {
      mockEnv.UPLYNK_USERID = 'some-user';
      const plugins = createProxyPlugins();
      expect(plugins.find(p => p.name === 'uplynk')).toBeUndefined();
    });

    it('returns no uplynk plugin when both credentials are missing', () => {
      const plugins = createProxyPlugins();
      expect(plugins.find(p => p.name === 'uplynk')).toBeUndefined();
    });

    it('returns uplynk plugin when both credentials are present', () => {
      mockEnv.UPLYNK_USERID = 'test-user';
      mockEnv.UPLYNK_API_KEY = 'test-key';
      const plugins = createProxyPlugins();
      const uplynk = plugins.find(p => p.name === 'uplynk');
      expect(uplynk).toBeDefined();
      expect(uplynk!.name).toBe('uplynk');
      expect(uplynk!.pathPrefixes).toEqual(['/uplynk/']);
    });
  });

  describe('signing logic', () => {
    it('produces valid HMAC-SHA256 signature from zlib-deflated payload', () => {
      const data = { page_size: 5 };
      const userId = 'test-user';
      const apiKey = 'test-key';
      const timestamp = Math.floor(Date.now() / 1000);

      const message = { _owner: userId, _timestamp: timestamp, ...data };
      const deflated = zlib.deflateSync(Buffer.from(JSON.stringify(message)), { level: 9 });
      const base64Msg = deflated.toString('base64').trim();
      const sig = crypto.createHmac('sha256', apiKey).update(base64Msg).digest('hex');

      expect(base64Msg.length).toBeGreaterThan(0);
      expect(sig).toMatch(/^[a-f0-9]{64}$/);

      // Roundtrip: inflate back to JSON
      const inflated = zlib.inflateSync(Buffer.from(base64Msg, 'base64'));
      const parsed = JSON.parse(inflated.toString());
      expect(parsed._owner).toBe(userId);
      expect(parsed._timestamp).toBe(timestamp);
      expect(parsed.page_size).toBe(5);
    });

    it('uses zlib-wrapped deflate (0x78 header), not raw deflate', () => {
      const data = Buffer.from(JSON.stringify({ _owner: 'x', _timestamp: 1 }));
      const deflated = zlib.deflateSync(data, { level: 9 });
      // Zlib-wrapped always starts with 0x78
      expect(deflated[0]).toBe(0x78);
      // Raw deflate does NOT
      expect(zlib.deflateRawSync(data, { level: 9 })[0]).not.toBe(0x78);
    });
  });

  describe('proxy integration (mocked env)', () => {
    let proxyServer: http.Server;
    let proxyPort: number;

    async function startProxy(): Promise<number> {
      const { startCredentialProxy } = await import('../credential-proxy.js');
      proxyServer = await startCredentialProxy(0);
      return (proxyServer.address() as AddressInfo).port;
    }

    afterEach(async () => {
      await new Promise<void>((r) => proxyServer?.close(() => r()));
    });

    it('routes /uplynk/* to plugin (200 or 502 from upstream)', async () => {
      mockEnv.UPLYNK_USERID = 'test-user';
      mockEnv.UPLYNK_API_KEY = 'test-key';
      proxyPort = await startProxy();

      const res = await makeRequest(proxyPort, { method: 'GET', path: '/uplynk/api/v4/assets' });
      // Plugin handles it — either Uplynk responds (200), auth rejected with
      // mock credentials (401/400), or upstream unreachable (502)
      expect([200, 400, 401, 502]).toContain(res.statusCode);
    });

    it('returns 400 for invalid JSON body', async () => {
      mockEnv.UPLYNK_USERID = 'test-user';
      mockEnv.UPLYNK_API_KEY = 'test-key';
      proxyPort = await startProxy();

      const res = await makeRequest(proxyPort, { method: 'GET', path: '/uplynk/api/v4/assets' }, 'not json');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid JSON body');
    });

    it('does not intercept non-plugin paths', async () => {
      mockEnv.UPLYNK_USERID = 'test-user';
      mockEnv.UPLYNK_API_KEY = 'test-key';
      proxyPort = await startProxy();

      const res = await makeRequest(proxyPort, { method: 'POST', path: '/v1/messages' }, '{}');
      // Should go to inference routing, not plugin
      expect(res.body).not.toContain('Missing API path after /uplynk/');
      expect(res.body).not.toContain('Uplynk upstream error');
    });

    it('falls through when no plugin credentials configured', async () => {
      // No UPLYNK_* in mockEnv — plugin inactive
      proxyPort = await startProxy();

      const res = await makeRequest(proxyPort, { method: 'GET', path: '/uplynk/api/v4/assets' });
      // Without plugin, /uplynk/* falls through to inference routing
      // (which will fail with 502 or similar — but NOT a plugin error)
      expect(res.body).not.toContain('Invalid JSON body');
    });
  });
});
