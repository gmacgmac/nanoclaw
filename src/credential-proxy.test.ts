import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
let mockEndpoints: Record<string, { baseUrl: string; apiKey: string }> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
  scanEndpoints: vi.fn(() => ({ ...mockEndpoints })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockEndpoints = {};
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  // --- Multi-endpoint routing tests ---

  describe('multi-endpoint routing', () => {
    let ollamaServer: http.Server;
    let ollamaPort: number;
    let lastOllamaHeaders: http.IncomingHttpHeaders;

    beforeEach(async () => {
      lastOllamaHeaders = {};
      ollamaServer = http.createServer((req, res) => {
        lastOllamaHeaders = { ...req.headers };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, vendor: 'ollama' }));
      });
      await new Promise<void>((resolve) =>
        ollamaServer.listen(0, '127.0.0.1', resolve),
      );
      ollamaPort = (ollamaServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise<void>((r) => ollamaServer?.close(() => r()));
    });

    it('routes to named endpoint when X-Nanoclaw-Endpoint header is set', async () => {
      mockEndpoints = {
        anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-ant-key' },
        ollama: { baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKey: 'ollama-key' },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'ollama',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(200);
      // Ollama upstream received the request with injected key
      expect(lastOllamaHeaders['x-api-key']).toBe('ollama-key');
      // Routing header stripped before forwarding
      expect(lastOllamaHeaders['x-nanoclaw-endpoint']).toBeUndefined();
      // Default upstream did NOT receive the request
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    });

    it('falls back to anthropic when endpoint header is absent', async () => {
      mockEndpoints = {
        anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-ant-key' },
        ollama: { baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKey: 'ollama-key' },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      // Default upstream (anthropic) received the request
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
      // Ollama did NOT receive the request
      expect(lastOllamaHeaders['x-api-key']).toBeUndefined();
    });

    it('falls back to anthropic when unknown vendor is requested', async () => {
      mockEndpoints = {
        anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-ant-key' },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'nonexistent',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      // Falls back to anthropic
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
    });

    it('handles case-insensitive endpoint header', async () => {
      mockEndpoints = {
        anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-ant-key' },
        ollama: { baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKey: 'ollama-key' },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'OLLAMA',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      expect(lastOllamaHeaders['x-api-key']).toBe('ollama-key');
    });

    it('injects correct key per vendor without leaking other keys', async () => {
      mockEndpoints = {
        anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'sk-ant-secret' },
        ollama: { baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKey: 'ollama-secret' },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      // Request to ollama
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'ollama',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      // Ollama got its own key, not anthropic's
      expect(lastOllamaHeaders['x-api-key']).toBe('ollama-secret');
      // Anthropic upstream was not contacted
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    });
  });
});
