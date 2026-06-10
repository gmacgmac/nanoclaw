import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../../config.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock('../../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

interface MockGroup {
  jid: string;
  name: string;
  folder: string;
  isMain?: boolean;
  containerConfig?: Record<string, unknown>;
}

interface MockChannel {
  name: string;
  ownsJid: (jid: string) => boolean;
  isConnected: () => boolean;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const { mockGroups, mockChannels } = vi.hoisted(() => ({
  mockGroups: {} as Record<string, MockGroup>,
  mockChannels: [] as MockChannel[],
}));

vi.mock('../../group-registry.js', () => ({
  getRegisteredGroups: () => mockGroups,
  getChannelList: () => mockChannels,
}));

import '../schemas/index.js';
import notifyRouter from './notify.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(notifyRouter);
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

interface NotifyResponse {
  ok: boolean;
  delivered: string[];
  failed: Array<{ jid: string; reason: string }>;
}

describe('POST /api/notify', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    for (const k of Object.keys(mockGroups)) delete mockGroups[k];
    mockChannels.length = 0;
    const handle = await listen(makeApp());
    base = handle.base;
    close = handle.close;
  });

  afterEach(async () => {
    await close();
  });

  it('delivers to a valid connected JID and returns ok=true', async () => {
    mockGroups['g1@internal'] = {
      jid: 'g1@internal',
      name: 'Group 1',
      folder: 'g1',
    };
    const sendMessage = vi.fn(async () => undefined);
    mockChannels.push({
      name: 'dashboard',
      ownsJid: (jid: string) => jid === 'g1@internal',
      isConnected: () => true,
      sendMessage,
    });

    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['g1@internal'], message: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotifyResponse;
    expect(body.ok).toBe(true);
    expect(body.delivered).toEqual(['g1@internal']);
    expect(body.failed).toEqual([]);
    expect(sendMessage).toHaveBeenCalledWith('g1@internal', 'hello');
  });

  it('reports unknown JID in failed with reason "Group not found"', async () => {
    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['unknown@internal'], message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotifyResponse;
    expect(body.ok).toBe(false);
    expect(body.delivered).toEqual([]);
    expect(body.failed).toEqual([
      { jid: 'unknown@internal', reason: 'Group not found' },
    ]);
  });

  it('reports disconnected channel in failed with reason "Channel disconnected"', async () => {
    mockGroups['g1@internal'] = {
      jid: 'g1@internal',
      name: 'Group 1',
      folder: 'g1',
    };
    mockChannels.push({
      name: 'dashboard',
      ownsJid: (jid: string) => jid === 'g1@internal',
      isConnected: () => false,
      sendMessage: vi.fn(async () => undefined),
    });

    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['g1@internal'], message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotifyResponse;
    expect(body.ok).toBe(false);
    expect(body.failed).toEqual([
      { jid: 'g1@internal', reason: 'Channel disconnected' },
    ]);
  });

  it('expands "*" to all registered groups, delivering only to connected ones', async () => {
    mockGroups['a@internal'] = { jid: 'a@internal', name: 'A', folder: 'a' };
    mockGroups['b@internal'] = { jid: 'b@internal', name: 'B', folder: 'b' };
    mockGroups['c@internal'] = { jid: 'c@internal', name: 'C', folder: 'c' };

    const sendA = vi.fn(async () => undefined);
    const sendC = vi.fn(async () => undefined);
    mockChannels.push({
      name: 'dash-a',
      ownsJid: (jid: string) => jid === 'a@internal',
      isConnected: () => true,
      sendMessage: sendA,
    });
    mockChannels.push({
      name: 'dash-b',
      ownsJid: (jid: string) => jid === 'b@internal',
      isConnected: () => false,
      sendMessage: vi.fn(async () => undefined),
    });
    mockChannels.push({
      name: 'dash-c',
      ownsJid: (jid: string) => jid === 'c@internal',
      isConnected: () => true,
      sendMessage: sendC,
    });

    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['*'], message: 'broadcast' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotifyResponse;
    expect(body.delivered.sort()).toEqual(['a@internal', 'c@internal']);
    expect(body.failed).toEqual([
      { jid: 'b@internal', reason: 'Channel disconnected' },
    ]);
    expect(body.ok).toBe(false);
    expect(sendA).toHaveBeenCalledWith('a@internal', 'broadcast');
    expect(sendC).toHaveBeenCalledWith('c@internal', 'broadcast');
  });

  it('returns 400 on empty targets array', async () => {
    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [], message: 'hi' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown[] };
    expect(body.error).toBe('Validation failed');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns 400 on empty message', async () => {
    const res = await fetch(`${base}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['g1@internal'], message: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown[] };
    expect(body.error).toBe('Validation failed');
  });
});
