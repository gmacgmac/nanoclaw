import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
let mockEndpoints: Record<string, { baseUrl: string; apiKey?: string; auth?: string; region?: string }> = {};
let mockWebSearchEndpoints: Record<
  string,
  { baseUrl: string; apiKey: string }
> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
  scanEndpoints: vi.fn(() => ({ ...mockEndpoints })),
  scanWebSearchEndpoints: vi.fn(() => ({ ...mockWebSearchEndpoints })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock AWS modules for sigv4 tests — default: no-op (modules are inert for non-sigv4 paths)
const mockGetAwsCredentials = vi.fn();
const mockSignRequestV4 = vi.fn();
vi.mock('./aws-credentials.js', () => ({
  getAwsCredentials: (...args: unknown[]) => mockGetAwsCredentials(...args),
}));
vi.mock('./aws-sigv4.js', () => ({
  signRequestV4: (...args: unknown[]) => mockSignRequestV4(...args),
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
    mockWebSearchEndpoints = {};
    mockGetAwsCredentials.mockReset();
    mockSignRequestV4.mockReset();
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
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
        ollama: {
          baseUrl: `http://127.0.0.1:${ollamaPort}`,
          apiKey: 'ollama-key',
        },
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
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
        ollama: {
          baseUrl: `http://127.0.0.1:${ollamaPort}`,
          apiKey: 'ollama-key',
        },
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
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
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
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
        ollama: {
          baseUrl: `http://127.0.0.1:${ollamaPort}`,
          apiKey: 'ollama-key',
        },
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
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-secret',
        },
        ollama: {
          baseUrl: `http://127.0.0.1:${ollamaPort}`,
          apiKey: 'ollama-secret',
        },
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

  // --- Web search routing tests ---

  describe('web search routing', () => {
    let wsServer: http.Server;
    let wsPort: number;
    let lastWsHeaders: http.IncomingHttpHeaders;
    let lastWsUrl: string;

    beforeEach(async () => {
      lastWsHeaders = {};
      lastWsUrl = '';
      wsServer = http.createServer((req, res) => {
        lastWsHeaders = { ...req.headers };
        lastWsUrl = req.url || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [] }));
      });
      await new Promise<void>((resolve) =>
        wsServer.listen(0, '127.0.0.1', resolve),
      );
      wsPort = (wsServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise<void>((r) => wsServer?.close(() => r()));
    });

    it('routes /web_search to web search vendor with Bearer auth', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ query: 'test', max_results: 5 }),
      );

      expect(res.statusCode).toBe(200);
      expect(lastWsHeaders['authorization']).toBe('Bearer ollama-ws-key');
      expect(lastWsUrl).toBe('/web_search');
    });

    it('routes /web_fetch to web search vendor with Bearer auth', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_fetch',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ url: 'https://example.com' }),
      );

      expect(res.statusCode).toBe(200);
      expect(lastWsHeaders['authorization']).toBe('Bearer ollama-ws-key');
      expect(lastWsUrl).toBe('/web_fetch');
    });

    it('defaults to ollama when vendor header is absent', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      // No X-Nanoclaw-Web-Search-Vendor header
      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(res.statusCode).toBe(200);
      expect(lastWsHeaders['authorization']).toBe('Bearer ollama-ws-key');
    });

    it('routes to specified vendor via header', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'ollama-ws-key',
        },
        brave: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'brave-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-web-search-vendor': 'brave',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(200);
      // Brave upstream got the request
      expect(lastWsHeaders['authorization']).toBe('Bearer brave-ws-key');
      // Ollama (default) did NOT get the request
      expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    });

    it('returns 404 for unknown web search vendor', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-web-search-vendor': 'nonexistent',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('nonexistent');
      expect(body.error).toContain('not configured');
    });

    it('strips routing headers before forwarding to upstream', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-web-search-vendor': 'ollama',
            'x-nanoclaw-endpoint': 'some-value',
            'x-api-key': 'should-be-stripped',
          },
        },
        '{}',
      );

      expect(lastWsHeaders['x-nanoclaw-web-search-vendor']).toBeUndefined();
      expect(lastWsHeaders['x-nanoclaw-endpoint']).toBeUndefined();
      expect(lastWsHeaders['x-api-key']).toBeUndefined();
    });

    it('handles case-insensitive vendor header', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-web-search-vendor': 'OLLAMA',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(200);
      expect(lastWsHeaders['authorization']).toBe('Bearer ollama-ws-key');
    });

    it('does not interfere with inference routing for non-web-search paths', async () => {
      mockEndpoints = {
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
      };
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: `http://127.0.0.1:${wsPort}`,
          apiKey: 'ollama-ws-key',
        },
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

      // Inference went to anthropic upstream, not web search
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
      expect(lastWsHeaders['authorization']).toBeUndefined();
    });

    it('returns 502 when web search upstream is unreachable', async () => {
      mockWebSearchEndpoints = {
        ollama: {
          baseUrl: 'http://127.0.0.1:59999',
          apiKey: 'ollama-ws-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/web_search',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(res.statusCode).toBe(502);
      expect(res.body).toBe('Bad Gateway');
    });
  });

  // --- Transform routing tests ---

  describe('transform routing', () => {
    let transformServer: http.Server;
    let transformPort: number;
    let lastTransformHeaders: http.IncomingHttpHeaders;
    let lastTransformBody: string;
    let lastTransformUrl: string;

    beforeEach(async () => {
      lastTransformHeaders = {};
      lastTransformBody = '';
      lastTransformUrl = '';
    });

    afterEach(async () => {
      await new Promise<void>((r) => transformServer?.close(() => r()));
    });

    function createMockOpenAIServer(
      responseBody: Record<string, unknown>,
      headers: Record<string, string> = { 'content-type': 'application/json' },
    ): Promise<number> {
      return new Promise((resolve) => {
        transformServer = http.createServer((req, res) => {
          lastTransformHeaders = { ...req.headers };
          lastTransformUrl = req.url || '';
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            lastTransformBody = Buffer.concat(chunks).toString();
            const body = JSON.stringify(responseBody);
            res.writeHead(200, {
              ...headers,
              'content-length': String(body.length),
            });
            res.end(body);
          });
        });
        transformServer.listen(0, '127.0.0.1', () => {
          resolve((transformServer.address() as AddressInfo).port);
        });
      });
    }

    function createMockStreamingOpenAIServer(
      sseChunks: string[],
    ): Promise<number> {
      return new Promise((resolve) => {
        transformServer = http.createServer((req, res) => {
          lastTransformHeaders = { ...req.headers };
          lastTransformUrl = req.url || '';
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            lastTransformBody = Buffer.concat(chunks).toString();
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            });
            for (const chunk of sseChunks) {
              res.write(chunk);
            }
            res.end();
          });
        });
        transformServer.listen(0, '127.0.0.1', () => {
          resolve((transformServer.address() as AddressInfo).port);
        });
      });
    }

    it('transforms request to OpenAI ChatCompletions and response back to Anthropic Messages', async () => {
      // Mock OpenAI-style upstream response
      const openaiResponse = {
        id: 'chatcmpl-123',
        model: 'deepseek-r1',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI format' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      transformPort = await createMockOpenAIServer(openaiResponse);

      mockEndpoints = {
        bedrock: {
          baseUrl: `http://127.0.0.1:${transformPort}`,
          apiKey: 'bedrock-api-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      // Anthropic Messages format request with transform header
      const anthropicReq = {
        model: 'deepseek-r1',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
      };

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock',
            'x-nanoclaw-transform': 'openai',
            'x-api-key': 'placeholder',
          },
        },
        JSON.stringify(anthropicReq),
      );

      expect(res.statusCode).toBe(200);

      // Verify upstream received OpenAI-format request at /v1/chat/completions
      expect(lastTransformUrl).toBe('/v1/chat/completions');
      const upstreamReq = JSON.parse(lastTransformBody);
      expect(upstreamReq.model).toBe('deepseek-r1');
      expect(upstreamReq.messages).toEqual([
        { role: 'user', content: 'Hello' },
      ]);
      expect(upstreamReq.max_tokens).toBe(1024);

      // Verify auth is Bearer-style
      expect(lastTransformHeaders['authorization']).toBe(
        'Bearer bedrock-api-key',
      );
      expect(lastTransformHeaders['x-api-key']).toBeUndefined();

      // Verify transform header was stripped
      expect(lastTransformHeaders['x-nanoclaw-transform']).toBeUndefined();
      expect(lastTransformHeaders['x-nanoclaw-endpoint']).toBeUndefined();

      // Verify response was reshaped to Anthropic Messages format
      const anthropicRes = JSON.parse(res.body);
      expect(anthropicRes.type).toBe('message');
      expect(anthropicRes.role).toBe('assistant');
      expect(anthropicRes.content).toEqual([
        { type: 'text', text: 'Hello from OpenAI format' },
      ]);
      expect(anthropicRes.stop_reason).toBe('end_turn');
      expect(anthropicRes.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
      });
    });

    it('transforms streaming OpenAI SSE to Anthropic SSE', async () => {
      const sseChunks = [
        'data: {"id":"chatcmpl-1","model":"deepseek-r1","choices":[{"delta":{"role":"assistant","content":"Hi"},"index":0,"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","model":"deepseek-r1","choices":[{"delta":{"content":" there"},"index":0,"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","model":"deepseek-r1","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      transformPort = await createMockStreamingOpenAIServer(sseChunks);

      mockEndpoints = {
        bedrock: {
          baseUrl: `http://127.0.0.1:${transformPort}`,
          apiKey: 'bedrock-api-key',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const anthropicReq = {
        model: 'deepseek-r1',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
        stream: true,
      };

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock',
            'x-nanoclaw-transform': 'openai',
          },
        },
        JSON.stringify(anthropicReq),
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      // Verify upstream received stream:true in the body
      const upstreamReq = JSON.parse(lastTransformBody);
      expect(upstreamReq.stream).toBe(true);

      // Response should contain Anthropic SSE events
      expect(res.body).toContain('event: message_start');
      expect(res.body).toContain('event: content_block_start');
      expect(res.body).toContain('event: content_block_delta');
      expect(res.body).toContain('"text_delta"');
      expect(res.body).toContain('Hi');
      expect(res.body).toContain(' there');
      expect(res.body).toContain('event: message_stop');
    });

    it('falls back to passthrough for unknown transform name', async () => {
      mockEndpoints = {
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
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
            'x-nanoclaw-endpoint': 'anthropic',
            'x-nanoclaw-transform': 'nonexistent',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      // Falls through to passthrough path (no transform found)
      expect(res.statusCode).toBe(200);
      // Used x-api-key auth (passthrough mode)
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
      // Transform header stripped
      expect(lastUpstreamHeaders['x-nanoclaw-transform']).toBeUndefined();
    });

    it('strips transform header even when no transform is applied', async () => {
      mockEndpoints = {
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
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
            'x-nanoclaw-transform': 'openai',
            'x-api-key': 'placeholder',
          },
        },
        JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        }),
      );

      // Transform header must never reach upstream
      expect(lastUpstreamHeaders['x-nanoclaw-transform']).toBeUndefined();
    });

    it('uses base URL path prefix when transform overrides path', async () => {
      // Set up base URL with a path prefix (simulating bare Mantle host with subpath)
      const openaiResponse = {
        id: 'chatcmpl-456',
        model: 'test-model',
        choices: [
          {
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
      };
      transformPort = await createMockOpenAIServer(openaiResponse);

      mockEndpoints = {
        bedrock: {
          baseUrl: `http://127.0.0.1:${transformPort}/prefix`,
          apiKey: 'bedrock-key',
        },
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
            'x-nanoclaw-endpoint': 'bedrock',
            'x-nanoclaw-transform': 'openai',
          },
        },
        JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        }),
      );

      // basePath (/prefix) + transform path (/v1/chat/completions)
      expect(lastTransformUrl).toBe('/prefix/v1/chat/completions');
    });
  });

  // --- Auth mode (vendorAuth) tests (BE_04) ---

  describe('vendor auth modes (BE_04)', () => {
    it('bearer vendor: replaces placeholder Authorization with real Bearer key', async () => {
      mockEndpoints = {
        bedrock_runtime: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'real-bedrock-api-key',
          auth: 'bearer',
          region: 'us-east-1',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_runtime',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      // Real Bearer injected
      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer real-bedrock-api-key',
      );
      // x-api-key NOT set
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
      // Routing header stripped
      expect(lastUpstreamHeaders['x-nanoclaw-endpoint']).toBeUndefined();
    });

    it('bearer vendor: strips inbound x-api-key and replaces with Bearer', async () => {
      mockEndpoints = {
        bedrock_runtime: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'real-bedrock-api-key',
          auth: 'bearer',
        },
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
            'x-nanoclaw-endpoint': 'bedrock_runtime',
            'x-api-key': 'some-placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer real-bedrock-api-key',
      );
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
    });

    it('default vendor (no _AUTH): still uses x-api-key, no Authorization', async () => {
      mockEndpoints = {
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
          // no auth field → defaults to x-api-key
        },
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

      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
      expect(lastUpstreamHeaders['authorization']).toBeUndefined();
    });

    it('sigv4 vendor: strips inbound auth, signs with AWS credentials', async () => {
      mockGetAwsCredentials.mockResolvedValue({
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'testsecret',
      });
      mockSignRequestV4.mockReturnValue({
        Authorization: 'AWS4-HMAC-SHA256 Credential=AKIATEST/20260603/us-east-1/bedrock/aws4_request, SignedHeaders=..., Signature=abc',
        'x-amz-date': '20260603T000000Z',
        'x-amz-content-sha256': 'bodyhash',
      });

      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          // no apiKey for sigv4
          auth: 'sigv4',
          region: 'us-east-1',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
            'x-api-key': 'placeholder',
          },
        },
        '{}',
      );

      // Inbound placeholders stripped, SigV4 Authorization injected
      expect(lastUpstreamHeaders['authorization']).toContain('AWS4-HMAC-SHA256');
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
      expect(lastUpstreamHeaders['x-amz-date']).toBe('20260603T000000Z');
    });

    it('bearer vendor does not leak key value in log calls', async () => {
      const { logger } = await import('./logger.js');
      vi.mocked(logger.info).mockClear();

      mockEndpoints = {
        bedrock_runtime: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'super-secret-key-12345',
          auth: 'bearer',
        },
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
            'x-nanoclaw-endpoint': 'bedrock_runtime',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      // Verify the secret key never appears in any log call
      const allLogCalls = [
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
      ];
      const logStr = JSON.stringify(allLogCalls);
      expect(logStr).not.toContain('super-secret-key-12345');
    });
  });

  // --- SigV4 auth wiring tests (BE_07) ---

  describe('SigV4 auth wiring (BE_07)', () => {
    beforeEach(() => {
      mockGetAwsCredentials.mockReset();
      mockSignRequestV4.mockReset();
    });

    it('sigv4 vendor: injects signed headers (Authorization, x-amz-date, x-amz-content-sha256)', async () => {
      mockGetAwsCredentials.mockResolvedValue({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      });
      mockSignRequestV4.mockReturnValue({
        Authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260603/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=abcdef1234567890',
        'x-amz-date': '20260603T120000Z',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });

      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          auth: 'sigv4',
          region: 'us-east-1',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
            'x-api-key': 'placeholder',
          },
        },
        JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      );

      // Signed headers injected
      expect(lastUpstreamHeaders['authorization']).toContain('AWS4-HMAC-SHA256');
      expect(lastUpstreamHeaders['x-amz-date']).toBe('20260603T120000Z');
      expect(lastUpstreamHeaders['x-amz-content-sha256']).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      // Placeholders stripped
      expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
      // Routing header stripped
      expect(lastUpstreamHeaders['x-nanoclaw-endpoint']).toBeUndefined();
    });

    it('sigv4 vendor with session token: includes x-amz-security-token', async () => {
      mockGetAwsCredentials.mockResolvedValue({
        accessKeyId: 'ASIATEMP',
        secretAccessKey: 'tempSecret',
        sessionToken: 'FwoGZXIvYXdzE...session-token',
      });
      mockSignRequestV4.mockReturnValue({
        Authorization: 'AWS4-HMAC-SHA256 Credential=ASIATEMP/...',
        'x-amz-date': '20260603T130000Z',
        'x-amz-content-sha256': 'abc123',
        'x-amz-security-token': 'FwoGZXIvYXdzE...session-token',
      });

      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          auth: 'sigv4',
          region: 'us-west-2',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['x-amz-security-token']).toBe(
        'FwoGZXIvYXdzE...session-token',
      );
      expect(lastUpstreamHeaders['authorization']).toContain('AWS4-HMAC-SHA256');
    });

    it('sigv4 vendor missing region: returns 500', async () => {
      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          auth: 'sigv4',
          // no region!
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/test/invoke',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Internal configuration error');
      // Credentials should not have been fetched
      expect(mockGetAwsCredentials).not.toHaveBeenCalled();
    });

    it('sigv4 vendor: credential resolution failure returns 502', async () => {
      const { logger } = await import('./logger.js');
      vi.mocked(logger.error).mockClear();

      mockGetAwsCredentials.mockRejectedValue(
        new Error('no provider could resolve credentials'),
      );

      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          auth: 'sigv4',
          region: 'us-east-1',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const res = await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/test/invoke',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Upstream auth unavailable');
      // Error was logged but no credential material leaked
      expect(logger.error).toHaveBeenCalled();
      const logStr = JSON.stringify(vi.mocked(logger.error).mock.calls);
      expect(logStr).not.toContain('no provider could resolve');
      expect(logStr).not.toContain('secretAccessKey');
    });

    it('sigv4 signing is called with correct method/url/body/region/service', async () => {
      mockGetAwsCredentials.mockResolvedValue({
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      mockSignRequestV4.mockReturnValue({
        Authorization: 'AWS4-HMAC-SHA256 Credential=AKID/...',
        'x-amz-date': '20260603T140000Z',
        'x-amz-content-sha256': 'bodyhash',
      });

      mockEndpoints = {
        bedrock_sigv4: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/prefix`,
          auth: 'sigv4',
          region: 'eu-west-1',
        },
      };
      proxyServer = await startCredentialProxy(0);
      proxyPort = (proxyServer.address() as AddressInfo).port;

      const reqBody = JSON.stringify({ prompt: 'test' });
      await makeRequest(
        proxyPort,
        {
          method: 'POST',
          path: '/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-endpoint': 'bedrock_sigv4',
            authorization: 'Bearer placeholder',
          },
        },
        reqBody,
      );

      // Verify signRequestV4 was called with the correct parameters
      expect(mockSignRequestV4).toHaveBeenCalledTimes(1);
      const signCall = mockSignRequestV4.mock.calls[0][0];
      expect(signCall.method).toBe('POST');
      expect(signCall.url.pathname).toBe(
        '/prefix/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream',
      );
      expect(signCall.url.host).toBe(`127.0.0.1:${upstreamPort}`);
      expect(signCall.body.toString()).toBe(reqBody);
      expect(signCall.region).toBe('eu-west-1');
      expect(signCall.service).toBe('bedrock');
      expect(signCall.credentials).toEqual({
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
    });

    it('non-sigv4 vendor in same test suite is unaffected (no AWS headers)', async () => {
      mockEndpoints = {
        anthropic: {
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-ant-key',
        },
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

      // Standard x-api-key auth, no SigV4 headers
      expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-key');
      expect(lastUpstreamHeaders['x-amz-date']).toBeUndefined();
      expect(lastUpstreamHeaders['x-amz-content-sha256']).toBeUndefined();
      expect(lastUpstreamHeaders['x-amz-security-token']).toBeUndefined();
      // Mocks not called for non-sigv4 vendor
      expect(mockGetAwsCredentials).not.toHaveBeenCalled();
      expect(mockSignRequestV4).not.toHaveBeenCalled();
    });
  });
});
