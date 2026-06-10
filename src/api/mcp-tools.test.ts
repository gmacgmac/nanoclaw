import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../config.js', () => ({
  loadToolAllowlist: () => ['Read', 'Write', 'Edit'],
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const mockGroups: Record<string, { jid: string; name: string; folder: string; containerConfig?: Record<string, unknown> }> = {};

vi.mock('../group-registry.js', () => ({
  getRegisteredGroup: (jid: string) => mockGroups[jid] ?? null,
}));

import { MCP_CATALOG_PATH } from './mcp-catalog.js';
import mcpToolsRouter from './routes/mcp-tools.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpToolsRouter);
  return app;
}

function listen(app: express.Express): Promise<{
  server: http.Server;
  base: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

describe('GET /api/groups/{jid}/mcp-tools', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
    fs.writeFileSync(
      MCP_CATALOG_PATH,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        servers: [
          {
            name: 'nanoclaw',
            source: 'ipc-builtin',
            tools: [{ name: 'send_message' }, { name: 'send_attachment' }],
          },
          {
            name: 'brave-search',
            source: 'opt-in',
            tools: [{ name: 'brave_search' }],
          },
        ],
      }),
    );
    const handle = await listen(makeApp());
    base = handle.base;
    close = handle.close;
  });

  afterEach(async () => {
    await close();
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
    for (const k of Object.keys(mockGroups)) delete mockGroups[k];
  });

  it('returns 200 with ceiling, mcpAvailable, denied for a present group', async () => {
    mockGroups['tg:1001'] = {
      jid: 'tg:1001',
      name: 'g1',
      folder: 'g1',
      containerConfig: { deniedTools: ['send_message', 'typo-tool'] },
    };
    const res = await fetch(`${base}/api/groups/tg:1001/mcp-tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        ceiling: string[];
        mcpAvailable: { servers: Array<{ name: string }> };
        denied: string[];
      };
    };
    expect(body.data.ceiling).toEqual(['Read', 'Write', 'Edit']);
    expect(body.data.mcpAvailable.servers.map((s) => s.name)).toEqual(
      expect.arrayContaining(['nanoclaw', 'brave-search']),
    );
    expect(body.data.denied).toEqual(['send_message']);
  });

  it('returns empty denied array when no deniedTools are configured', async () => {
    mockGroups['tg:1002'] = {
      jid: 'tg:1002',
      name: 'g2',
      folder: 'g2',
      containerConfig: {},
    };
    const res = await fetch(`${base}/api/groups/tg:1002/mcp-tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { denied: string[] } };
    expect(body.data.denied).toEqual([]);
  });

  it('returns 404 for a missing group', async () => {
    const res = await fetch(`${base}/api/groups/tg:9999/mcp-tools`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});
