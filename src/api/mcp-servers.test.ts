import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

import {
  MCP_CATALOG_PATH,
  buildMcpCatalog,
  refreshMcpCatalog,
} from './mcp-catalog.js';
import mcpServersRouter from './routes/mcp-servers.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpServersRouter);
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

describe('MCP catalog (mcp-catalog.ts)', () => {
  beforeEach(() => {
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
  });

  it('buildMcpCatalog finds the nanoclaw IPC server and 3 opt-in servers', () => {
    const cat = buildMcpCatalog();
    const names = cat.servers.map((s) => s.name).sort();
    expect(names).toContain('nanoclaw');
    expect(names).toContain('brave-search');
    expect(names).toContain('nanoclaw-web-search');
    expect(names).toContain('nanoclaw-transcription');
    const ipc = cat.servers.find((s) => s.name === 'nanoclaw');
    expect(ipc?.source).toBe('ipc-builtin');
    expect(ipc?.tools.length).toBeGreaterThan(0);
    const optIn = cat.servers.find((s) => s.name === 'brave-search');
    expect(optIn?.source).toBe('opt-in');
  });

  it('refreshMcpCatalog writes mcp-catalog.json to disk', () => {
    expect(fs.existsSync(MCP_CATALOG_PATH)).toBe(false);
    refreshMcpCatalog();
    expect(fs.existsSync(MCP_CATALOG_PATH)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(MCP_CATALOG_PATH, 'utf-8'));
    expect(parsed.servers.length).toBeGreaterThan(0);
  });
});

describe('GET /api/mcp/servers', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
    const handle = await listen(makeApp());
    base = handle.base;
    close = handle.close;
  });

  afterEach(async () => {
    await close();
    if (fs.existsSync(MCP_CATALOG_PATH)) fs.unlinkSync(MCP_CATALOG_PATH);
  });

  it('returns 503 when catalog is missing', async () => {
    const res = await fetch(`${base}/api/mcp/servers`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('NOT_CONFIGURED');
  });

  it('returns 200 with catalog when present', async () => {
    refreshMcpCatalog();
    const res = await fetch(`${base}/api/mcp/servers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { servers: Array<{ name: string; source: string }> };
    };
    expect(Array.isArray(body.data.servers)).toBe(true);
    expect(body.data.servers.length).toBeGreaterThan(0);
  });
});
