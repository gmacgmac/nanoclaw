/**
 * Brave Search MCP Server for NanoClaw
 * Wraps the Brave Search API as an MCP tool.
 * API key is injected via BRAVE_SEARCH_API_KEY env var (credential proxy).
 * No secrets are logged or exposed to stdout (MCP protocol channel).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESULTS = 20;

interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
  page_age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
  error?: {
    code?: string;
    message?: string;
  };
}

async function braveSearch(query: string, count: number): Promise<string> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY environment variable is not set');
  }

  const url = new URL(BRAVE_API_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, MAX_RESULTS)));

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (response.status === 401) {
    throw new Error('Invalid Brave Search API key');
  }
  if (response.status === 429) {
    throw new Error('Brave Search rate limit exceeded');
  }
  if (!response.ok) {
    throw new Error(`Brave Search API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as BraveSearchResponse;

  if (data.error) {
    throw new Error(`Brave Search error: ${data.error.message || data.error.code}`);
  }

  const results = data.web?.results ?? [];
  if (results.length === 0) {
    return 'No results found.';
  }

  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
      if (r.description) lines.push(`   ${r.description}`);
      if (r.page_age) lines.push(`   Published: ${r.page_age}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

const server = new McpServer({
  name: 'brave-search',
  version: '1.0.0',
});

server.tool(
  'brave_search',
  'Search the web using Brave Search. Returns titles, URLs, snippets, and published dates.',
  {
    query: z.string().describe('The search query'),
    count: z.number().int().min(1).max(MAX_RESULTS).default(10).describe(`Number of results to return (1-${MAX_RESULTS}, default 10)`),
  },
  async (args) => {
    try {
      const results = await braveSearch(args.query, args.count ?? 10);
      return { content: [{ type: 'text' as const, text: results }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log to stderr only — stdout is the MCP protocol channel
      process.stderr.write(`[brave-search] Error: ${message}\n`);
      return {
        content: [{ type: 'text' as const, text: `Search failed: ${message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
