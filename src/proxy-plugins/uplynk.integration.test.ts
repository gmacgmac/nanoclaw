/**
 * Uplynk proxy plugin — integration tests (real Uplynk API).
 *
 * These tests hit the real Uplynk API through the credential proxy.
 * They are SKIPPED automatically when UPLYNK_USERID + UPLYNK_API_KEY
 * are not configured in ~/.config/nanoclaw/secrets.env.
 *
 * To enable:
 *   1. Add to ~/.config/nanoclaw/secrets.env:
 *        UPLYNK_USERID=your_owner_id
 *        UPLYNK_API_KEY=your_api_key
 *
 *   2. Run:
 *        npm test -- src/proxy-plugins/uplynk.integration.test.ts
 *
 * Note: Tests include 1.5s delays between requests to avoid Uplynk's
 * timestamp-based replay protection (same msg+sig in same second → 400).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { readEnvFile } from '../env.js';
import { startCredentialProxy } from '../credential-proxy.js';

// --- Credential check (sync, at module load) ---

const homeDir = process.env.HOME || '';
const secretsPath = path.join(homeDir, '.config', 'nanoclaw', 'secrets.env');
let hasCredentials = false;
try {
  const content = fs.readFileSync(secretsPath, 'utf-8');
  hasCredentials =
    content.includes('UPLYNK_USERID=') && content.includes('UPLYNK_API_KEY=');
} catch {
  // secrets.env doesn't exist
}

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
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Tests ---

const describeOrSkip = hasCredentials ? describe : describe.skip;

describeOrSkip('uplynk proxy plugin — live API', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = await startCredentialProxy(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('GET /uplynk/api/v4/assets returns asset collection', async () => {
    const res = await makeRequest(port, {
      method: 'GET',
      path: '/uplynk/api/v4/assets',
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json['@type']).toBe('Collection');
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items.length).toBeGreaterThan(0);
  });

  it('GET with JSON body signs data into query string', async () => {
    await delay(1500); // avoid timestamp replay
    const res = await makeRequest(
      port,
      { method: 'GET', path: '/uplynk/api/v4/assets' },
      '{"page_size": 2}',
    );
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json['@type']).toBe('Collection');
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await makeRequest(
      port,
      { method: 'GET', path: '/uplynk/api/v4/assets' },
      'not json',
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid JSON body');
  });

  it('non-plugin path bypasses plugin', async () => {
    await delay(1500);
    const res = await makeRequest(
      port,
      { method: 'POST', path: '/v1/messages' },
      '{}',
    );
    // Goes to inference routing, not plugin
    expect(res.body).not.toContain('Uplynk upstream error');
  });
});
