/**
 * NanoClaw Web Search MCP Server
 * Exposes web_search and web_fetch tools that route through the credential proxy
 * to Ollama's web search API. The proxy injects real API keys — this server
 * never sees them.
 *
 * Environment variables (set by container-runner):
 *   NANOCLAW_PROXY_HOST — credential proxy host (e.g. host.docker.internal)
 *   NANOCLAW_PROXY_PORT — credential proxy port
 *   NANOCLAW_WEB_SEARCH_VENDOR — vendor name for routing header (default: ollama)
 *
 * Security: No secrets hardcoded. All errors to stderr. Stdout is MCP protocol only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validateUrl, type SsrfValidatorOptions } from './lib/ssrf-validator.js';

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const DEFAULT_VENDOR = 'ollama';

// --- SSRF Protection Config ---
// Parsed from NANOCLAW_SSRF_CONFIG env var (JSON), set by container-runner.
// Absent or invalid → SSRF protection enabled with defaults (secure by default).

interface SsrfConfig {
  enabled: boolean;
  allowPrivateNetworks?: boolean;
}

function parseSsrfConfig(): SsrfConfig {
  const raw = process.env.NANOCLAW_SSRF_CONFIG;
  if (!raw) return { enabled: true }; // secure by default

  try {
    const parsed = JSON.parse(raw) as Partial<SsrfConfig>;
    return {
      enabled: parsed.enabled !== false, // only explicitly false disables
      allowPrivateNetworks: parsed.allowPrivateNetworks === true,
    };
  } catch {
    process.stderr.write('[nanoclaw-web-search] Invalid NANOCLAW_SSRF_CONFIG, defaulting to enabled\n');
    return { enabled: true };
  }
}

const ssrfConfig = parseSsrfConfig();

function getSsrfOptions(): SsrfValidatorOptions {
  return {
    allowPrivateNetworks: ssrfConfig.allowPrivateNetworks,
  };
}

function getProxyUrl(path: string): string {
  const host = process.env.NANOCLAW_PROXY_HOST;
  const port = process.env.NANOCLAW_PROXY_PORT;
  if (!host || !port) {
    throw new Error(
      'NANOCLAW_PROXY_HOST and NANOCLAW_PROXY_PORT must be set',
    );
  }
  return `http://${host}:${port}${path}`;
}

function getVendorHeader(): Record<string, string> {
  const vendor = process.env.NANOCLAW_WEB_SEARCH_VENDOR || DEFAULT_VENDOR;
  return { 'X-Nanoclaw-Web-Search-Vendor': vendor };
}

// --- Types ---

interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

interface WebSearchResponse {
  results?: WebSearchResult[];
  error?: string;
}

interface WebFetchResponse {
  title?: string;
  content?: string;
  links?: string[];
  error?: string;
}

// --- Proxy callers ---

async function proxyWebSearch(
  query: string,
  maxResults: number,
): Promise<string> {
  const url = getProxyUrl('/web_search');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getVendorHeader(),
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

  const data = (await response.json()) as WebSearchResponse;
  if (data.error) {
    throw new Error(`Web search error: ${data.error}`);
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    return 'No results found.';
  }

  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
      if (r.content) lines.push(`   ${r.content}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

async function proxyWebFetch(targetUrl: string): Promise<string> {
  // SSRF protection: validate the agent-supplied URL before forwarding to proxy
  if (ssrfConfig.enabled) {
    const validation = await validateUrl(targetUrl, getSsrfOptions());
    if (!validation.allowed) {
      throw new Error(`URL blocked by SSRF protection: ${validation.reason}`);
    }
  }

  const url = getProxyUrl('/web_fetch');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getVendorHeader(),
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

  const data = (await response.json()) as WebFetchResponse;
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

// --- MCP Server ---

const server = new McpServer({
  name: 'nanoclaw-web-search',
  version: '1.0.0',
});

server.tool(
  'web_search',
  'Search the web using the configured web search provider (routed through credential proxy). Returns titles, URLs, and content snippets.',
  {
    query: z.string().describe('The search query'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESULTS)
      .default(DEFAULT_RESULTS)
      .describe(`Number of results (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS})`),
  },
  async (args) => {
    try {
      const text = await proxyWebSearch(
        args.query,
        args.max_results ?? DEFAULT_RESULTS,
      );
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nanoclaw-web-search] web_search error: ${message}\n`);
      return {
        content: [{ type: 'text' as const, text: `Web search failed: ${message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'web_fetch',
  'Fetch the content of a web page by URL (routed through credential proxy). Returns the page title, text content, and links.',
  {
    url: z.string().url().describe('The URL to fetch'),
  },
  async (args) => {
    try {
      const text = await proxyWebFetch(args.url);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nanoclaw-web-search] web_fetch error: ${message}\n`);
      return {
        content: [{ type: 'text' as const, text: `Web fetch failed: ${message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
