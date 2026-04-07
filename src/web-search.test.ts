/**
 * VERIFY_01: Consolidated web search integration tests.
 *
 * Tests the logic that lives in container-side packages (agent-runner, MCP server)
 * which can't run vitest directly. Mirrors the pattern from tool-restrictions.test.ts.
 *
 * Existing per-module tests (env.test.ts, credential-proxy.test.ts, container-runner.test.ts)
 * cover their respective units. This file covers cross-cutting integration logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// ---------------------------------------------------------------------------
// 1. Agent-runner: ANTHROPIC_CUSTOM_HEADERS construction
//    Mirrors logic from container/agent-runner/src/index.ts main()
// ---------------------------------------------------------------------------

function buildCustomHeaders(
  containerEndpoint?: string,
  envEndpoint?: string,
  containerWebSearchVendor?: string,
  envWebSearchVendor?: string,
): string {
  const endpoint = containerEndpoint || envEndpoint || 'anthropic';
  const webSearchVendor = containerWebSearchVendor || envWebSearchVendor || 'ollama';
  return [
    `X-Nanoclaw-Endpoint: ${endpoint}`,
    `X-Nanoclaw-Web-Search-Vendor: ${webSearchVendor}`,
  ].join('\n');
}

describe('agent-runner custom headers', () => {
  it('includes both endpoint and web search vendor headers', () => {
    const headers = buildCustomHeaders('anthropic', undefined, 'ollama', undefined);
    expect(headers).toContain('X-Nanoclaw-Endpoint: anthropic');
    expect(headers).toContain('X-Nanoclaw-Web-Search-Vendor: ollama');
  });

  it('headers are newline-separated', () => {
    const headers = buildCustomHeaders('anthropic', undefined, 'ollama', undefined);
    const lines = headers.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^X-Nanoclaw-Endpoint:/);
    expect(lines[1]).toMatch(/^X-Nanoclaw-Web-Search-Vendor:/);
  });

  it('defaults endpoint to anthropic when nothing provided', () => {
    const headers = buildCustomHeaders(undefined, undefined, undefined, undefined);
    expect(headers).toContain('X-Nanoclaw-Endpoint: anthropic');
  });

  it('defaults web search vendor to ollama when nothing provided', () => {
    const headers = buildCustomHeaders(undefined, undefined, undefined, undefined);
    expect(headers).toContain('X-Nanoclaw-Web-Search-Vendor: ollama');
  });

  it('containerInput.endpoint takes priority over env', () => {
    const headers = buildCustomHeaders('zai', 'ollama', undefined, undefined);
    expect(headers).toContain('X-Nanoclaw-Endpoint: zai');
  });

  it('containerInput.webSearchVendor takes priority over env', () => {
    const headers = buildCustomHeaders(undefined, undefined, 'brave', 'ollama');
    expect(headers).toContain('X-Nanoclaw-Web-Search-Vendor: brave');
  });

  it('falls back to env values when containerInput fields are absent', () => {
    const headers = buildCustomHeaders(undefined, 'ollama', undefined, 'brave');
    expect(headers).toContain('X-Nanoclaw-Endpoint: ollama');
    expect(headers).toContain('X-Nanoclaw-Web-Search-Vendor: brave');
  });
});


// ---------------------------------------------------------------------------
// 2. MCP server: proxy caller logic
//    Mirrors proxyWebSearch / proxyWebFetch from nanoclaw-web-search MCP server.
//    Tests the HTTP calling pattern, header injection, and response formatting.
// ---------------------------------------------------------------------------

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const DEFAULT_VENDOR = 'ollama';

interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

/** Mirrors getProxyUrl from MCP server */
function getProxyUrl(host: string, port: number, path: string): string {
  return `http://${host}:${port}${path}`;
}

/** Mirrors proxyWebSearch from MCP server */
async function proxyWebSearch(
  host: string,
  port: number,
  vendor: string,
  query: string,
  maxResults: number,
): Promise<string> {
  const url = getProxyUrl(host, port, '/web_search');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Nanoclaw-Web-Search-Vendor': vendor,
    },
    body: JSON.stringify({ query, max_results: maxResults }),
  });

  if (response.status === 404) {
    const data = (await response.json()) as { error?: string };
    throw new Error(data.error || 'Web search vendor not configured');
  }
  if (response.status === 429) {
    throw new Error('Web search rate limit exceeded');
  }
  if (!response.ok) {
    throw new Error(`Web search proxy error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { results?: WebSearchResult[]; error?: string };
  if (data.error) {
    throw new Error(`Web search error: ${data.error}`);
  }

  const results = data.results ?? [];
  if (results.length === 0) return 'No results found.';

  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
      if (r.content) lines.push(`   ${r.content}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Mirrors proxyWebFetch from MCP server */
async function proxyWebFetch(
  host: string,
  port: number,
  vendor: string,
  targetUrl: string,
): Promise<string> {
  const url = getProxyUrl(host, port, '/web_fetch');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Nanoclaw-Web-Search-Vendor': vendor,
    },
    body: JSON.stringify({ url: targetUrl }),
  });

  if (response.status === 404) {
    const data = (await response.json()) as { error?: string };
    throw new Error(data.error || 'Web search vendor not configured');
  }
  if (response.status === 429) {
    throw new Error('Web fetch rate limit exceeded');
  }
  if (!response.ok) {
    throw new Error(`Web fetch proxy error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { title?: string; content?: string; links?: string[]; error?: string };
  if (data.error) {
    throw new Error(`Web fetch error: ${data.error}`);
  }

  const parts: string[] = [];
  if (data.title) parts.push(`Title: ${data.title}`);
  if (data.content) parts.push(`\n${data.content}`);
  if (data.links && data.links.length > 0) {
    parts.push(`\nLinks:\n${data.links.map((l) => `  - ${l}`).join('\n')}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'No content returned.';
}

describe('MCP server proxy callers', () => {
  let server: http.Server;
  let port: number;
  let lastHeaders: http.IncomingHttpHeaders;
  let lastBody: string;
  let lastUrl: string;
  let responseStatus: number;
  let responseBody: string;

  beforeEach(async () => {
    lastHeaders = {};
    lastBody = '';
    lastUrl = '';
    responseStatus = 200;
    responseBody = JSON.stringify({ results: [] });

    server = http.createServer((req, res) => {
      lastHeaders = { ...req.headers };
      lastUrl = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString();
        res.writeHead(responseStatus, { 'content-type': 'application/json' });
        res.end(responseBody);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  // --- web_search ---

  it('web_search sends POST to /web_search with vendor header', async () => {
    responseBody = JSON.stringify({ results: [{ title: 'Test', url: 'https://example.com', content: 'snippet' }] });
    await proxyWebSearch('127.0.0.1', port, 'ollama', 'test query', 5);

    expect(lastUrl).toBe('/web_search');
    expect(lastHeaders['x-nanoclaw-web-search-vendor']).toBe('ollama');
    expect(lastHeaders['content-type']).toBe('application/json');
    const body = JSON.parse(lastBody);
    expect(body.query).toBe('test query');
    expect(body.max_results).toBe(5);
  });

  it('web_search formats results correctly', async () => {
    responseBody = JSON.stringify({
      results: [
        { title: 'First', url: 'https://a.com', content: 'Content A' },
        { title: 'Second', url: 'https://b.com', content: 'Content B' },
      ],
    });
    const result = await proxyWebSearch('127.0.0.1', port, 'ollama', 'test', 5);

    expect(result).toContain('1. First');
    expect(result).toContain('URL: https://a.com');
    expect(result).toContain('Content A');
    expect(result).toContain('2. Second');
    expect(result).toContain('URL: https://b.com');
  });

  it('web_search returns "No results found." for empty results', async () => {
    responseBody = JSON.stringify({ results: [] });
    const result = await proxyWebSearch('127.0.0.1', port, 'ollama', 'nothing', 5);
    expect(result).toBe('No results found.');
  });

  it('web_search throws on 404 with vendor error', async () => {
    responseStatus = 404;
    responseBody = JSON.stringify({ error: 'Web search vendor "fake" not configured' });
    await expect(proxyWebSearch('127.0.0.1', port, 'fake', 'test', 5))
      .rejects.toThrow('not configured');
  });

  it('web_search throws on 429 rate limit', async () => {
    responseStatus = 429;
    responseBody = '{}';
    await expect(proxyWebSearch('127.0.0.1', port, 'ollama', 'test', 5))
      .rejects.toThrow('rate limit');
  });

  it('web_search throws on upstream error field', async () => {
    responseBody = JSON.stringify({ error: 'upstream failure' });
    await expect(proxyWebSearch('127.0.0.1', port, 'ollama', 'test', 5))
      .rejects.toThrow('upstream failure');
  });

  it('web_search throws on 500', async () => {
    responseStatus = 500;
    responseBody = '{}';
    await expect(proxyWebSearch('127.0.0.1', port, 'ollama', 'test', 5))
      .rejects.toThrow('HTTP 500');
  });

  // --- web_fetch ---

  it('web_fetch sends POST to /web_fetch with vendor header', async () => {
    responseBody = JSON.stringify({ title: 'Page', content: 'Hello', links: [] });
    await proxyWebFetch('127.0.0.1', port, 'ollama', 'https://example.com');

    expect(lastUrl).toBe('/web_fetch');
    expect(lastHeaders['x-nanoclaw-web-search-vendor']).toBe('ollama');
    const body = JSON.parse(lastBody);
    expect(body.url).toBe('https://example.com');
  });

  it('web_fetch formats response with title, content, and links', async () => {
    responseBody = JSON.stringify({
      title: 'Example Page',
      content: 'Page content here',
      links: ['https://link1.com', 'https://link2.com'],
    });
    const result = await proxyWebFetch('127.0.0.1', port, 'ollama', 'https://example.com');

    expect(result).toContain('Title: Example Page');
    expect(result).toContain('Page content here');
    expect(result).toContain('https://link1.com');
    expect(result).toContain('https://link2.com');
  });

  it('web_fetch returns "No content returned." for empty response', async () => {
    responseBody = JSON.stringify({});
    const result = await proxyWebFetch('127.0.0.1', port, 'ollama', 'https://example.com');
    expect(result).toBe('No content returned.');
  });

  it('web_fetch throws on 404', async () => {
    responseStatus = 404;
    responseBody = JSON.stringify({ error: 'vendor not configured' });
    await expect(proxyWebFetch('127.0.0.1', port, 'fake', 'https://example.com'))
      .rejects.toThrow('not configured');
  });

  it('web_fetch throws on 429 rate limit', async () => {
    responseStatus = 429;
    responseBody = '{}';
    await expect(proxyWebFetch('127.0.0.1', port, 'ollama', 'https://example.com'))
      .rejects.toThrow('rate limit');
  });

  it('web_fetch throws on upstream error field', async () => {
    responseBody = JSON.stringify({ error: 'fetch failed' });
    await expect(proxyWebFetch('127.0.0.1', port, 'ollama', 'https://example.com'))
      .rejects.toThrow('fetch failed');
  });
});
