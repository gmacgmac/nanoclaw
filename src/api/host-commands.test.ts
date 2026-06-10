import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../config.js', () => ({
  loadToolAllowlist: () => [],
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const mockGroups: Record<string, { jid: string; name: string; folder: string; containerConfig?: Record<string, unknown> }> = {};

vi.mock('../group-registry.js', () => ({
  getRegisteredGroup: (jid: string) => mockGroups[jid] ?? null,
  updateRegisteredGroup: vi.fn(async () => undefined),
}));

import hostCommandsRouter from './routes/host-commands.js';
import groupConfigFieldsRouter from './routes/group-config-fields.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(hostCommandsRouter);
  app.use(groupConfigFieldsRouter);
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

describe('GET /api/host-commands', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const handle = await listen(makeApp());
    base = handle.base;
    close = handle.close;
  });

  afterEach(async () => {
    await close();
  });

  it('returns 200 with gated and ungated command lists', async () => {
    const res = await fetch(`${base}/api/host-commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        gated: Array<{ name: string; description: string }>;
        ungated: Array<{ name: string; description: string }>;
      };
    };
    expect(body.data.gated.map((c) => c.name)).toEqual(['model', 'version']);
    expect(body.data.ungated.map((c) => c.name)).toEqual([
      'shutdown',
      'stop',
      'context',
      'newsession',
    ]);
  });
});

describe('PATCH /api/groups/{jid}/allowed-host-commands validator', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    mockGroups['tg:2001'] = {
      jid: 'tg:2001',
      name: 'g1',
      folder: 'g1',
      containerConfig: { allowedHostCommands: [] },
    };
    const handle = await listen(makeApp());
    base = handle.base;
    close = handle.close;
  });

  afterEach(async () => {
    await close();
    for (const k of Object.keys(mockGroups)) delete mockGroups[k];
  });

  it('accepts a valid gated command', async () => {
    const res = await fetch(
      `${base}/api/groups/tg:2001/allowed-host-commands`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['model'] }),
      },
    );
    expect(res.status).toBe(200);
  });

  it('rejects an unknown command with 400', async () => {
    const res = await fetch(
      `${base}/api/groups/tg:2001/allowed-host-commands`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['bogus'] }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('INVALID_VALUE');
  });

  it('rejects an ungated command with 400', async () => {
    const res = await fetch(
      `${base}/api/groups/tg:2001/allowed-host-commands`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add: ['shutdown'] }),
      },
    );
    expect(res.status).toBe(400);
  });
});
