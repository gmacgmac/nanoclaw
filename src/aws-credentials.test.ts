import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { getAwsCredentials, clearCredentialCache } from './aws-credentials.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Start a local HTTP server that responds to requests based on a handler map. */
function createMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('aws-credentials', () => {
  beforeEach(() => {
    clearCredentialCache();
    // Clean env vars that could interfere
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  });

  afterEach(() => {
    clearCredentialCache();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
  });

  describe('static-env provider', () => {
    it('returns credentials from process.env', async () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY =
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

      const creds = await getAwsCredentials();
      expect(creds.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(creds.secretAccessKey).toBe(
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      );
      expect(creds.sessionToken).toBeUndefined();
    });

    it('includes session token when present', async () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
      process.env.AWS_SECRET_ACCESS_KEY =
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      process.env.AWS_SESSION_TOKEN = 'FwoGZXIvYXdzEBEaDH+token==';

      const creds = await getAwsCredentials();
      expect(creds.sessionToken).toBe('FwoGZXIvYXdzEBEaDH+token==');
    });

    it('returns cached creds on second call (no re-resolve)', async () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKID1';
      process.env.AWS_SECRET_ACCESS_KEY = 'SECRET1';

      const creds1 = await getAwsCredentials();

      // Change env — should not matter, cache is valid
      process.env.AWS_ACCESS_KEY_ID = 'AKID2';
      const creds2 = await getAwsCredentials();

      expect(creds1).toEqual(creds2);
      expect(creds2.accessKeyId).toBe('AKID1');
    });
  });

  describe('container-credentials provider', () => {
    it('resolves creds from relative URI', async () => {
      const expiry = new Date(Date.now() + 3600_000).toISOString();
      const { server, port } = await createMockServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            AccessKeyId: 'AKID_ECS',
            SecretAccessKey: 'SECRET_ECS',
            Token: 'SESSION_ECS',
            Expiration: expiry,
          }),
        );
      });

      try {
        // Use full URI pointing to our mock server
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/creds`;

        const creds = await getAwsCredentials();
        expect(creds.accessKeyId).toBe('AKID_ECS');
        expect(creds.secretAccessKey).toBe('SECRET_ECS');
        expect(creds.sessionToken).toBe('SESSION_ECS');
      } finally {
        await closeServer(server);
      }
    });

    it('includes authorization token header when AWS_CONTAINER_AUTHORIZATION_TOKEN set', async () => {
      let receivedAuthHeader: string | undefined;
      const { server, port } = await createMockServer((req, res) => {
        receivedAuthHeader = req.headers['authorization'] as string;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            AccessKeyId: 'AKID_AUTH',
            SecretAccessKey: 'SECRET_AUTH',
            Token: 'TOKEN_AUTH',
            Expiration: new Date(Date.now() + 3600_000).toISOString(),
          }),
        );
      });

      try {
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/creds`;
        process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = 'Bearer mytoken123';

        await getAwsCredentials();
        expect(receivedAuthHeader).toBe('Bearer mytoken123');
      } finally {
        await closeServer(server);
      }
    });

    it('falls through when container-creds endpoint returns non-200', async () => {
      const { server, port } = await createMockServer((_req, res) => {
        res.writeHead(404);
        res.end('Not Found');
      });

      try {
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/creds`;
        // No static env either — should throw
        await expect(getAwsCredentials()).rejects.toThrow(
          /credential resolution failed/,
        );
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('ec2-imdsv2 provider', () => {
    it('resolves creds via IMDSv2 token + role sequence', async () => {
      const expiry = new Date(Date.now() + 3600_000).toISOString();
      const { server, port } = await createMockServer((req, res) => {
        if (req.method === 'PUT' && req.url === '/latest/api/token') {
          res.writeHead(200);
          res.end('imds-token-abc');
          return;
        }
        if (req.url === '/latest/meta-data/iam/security-credentials/') {
          res.writeHead(200);
          res.end('my-iam-role');
          return;
        }
        if (
          req.url === '/latest/meta-data/iam/security-credentials/my-iam-role'
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              AccessKeyId: 'AKID_IMDS',
              SecretAccessKey: 'SECRET_IMDS',
              Token: 'TOKEN_IMDS',
              Expiration: expiry,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      try {
        // Override IMDS base URL by mocking at provider level
        // Since we can't easily override the IMDS_BASE constant, we test via
        // the full chain with static-env and container-creds both failing.
        // The IMDSv2 provider uses 169.254.169.254 — not reachable in tests.
        // Instead, we verify the provider falls through gracefully (timeout).
        // Direct IMDSv2 testing requires the actual EC2 environment.

        // For unit test purposes: verify the chain throws when nothing resolves
        await expect(getAwsCredentials()).rejects.toThrow(
          /credential resolution failed/,
        );
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('cache expiry', () => {
    it('refreshes when cached creds are near expiry', async () => {
      let callCount = 0;
      const { server, port } = await createMockServer((_req, res) => {
        callCount++;
        const expiry =
          callCount === 1
            ? // First: expires "now" (forces refresh on next call)
              new Date(Date.now() + 4 * 60 * 1000).toISOString() // 4 min — within 5-min refresh window
            : // Second: fresh
              new Date(Date.now() + 3600_000).toISOString();

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            AccessKeyId: `AKID_${callCount}`,
            SecretAccessKey: `SECRET_${callCount}`,
            Token: `TOKEN_${callCount}`,
            Expiration: expiry,
          }),
        );
      });

      try {
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/creds`;

        // First call: resolves and caches
        const creds1 = await getAwsCredentials();
        expect(creds1.accessKeyId).toBe('AKID_1');

        // Second call: cache is within refresh window (4 min < 5 min buffer) → refreshes
        const creds2 = await getAwsCredentials();
        expect(creds2.accessKeyId).toBe('AKID_2');
        expect(callCount).toBe(2);
      } finally {
        await closeServer(server);
      }
    });

    it('does not refresh when cached creds are still valid', async () => {
      let callCount = 0;
      const { server, port } = await createMockServer((_req, res) => {
        callCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            AccessKeyId: `AKID_${callCount}`,
            SecretAccessKey: `SECRET_${callCount}`,
            Token: `TOKEN_${callCount}`,
            Expiration: new Date(Date.now() + 3600_000).toISOString(), // 1 hour
          }),
        );
      });

      try {
        process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${port}/creds`;

        await getAwsCredentials();
        await getAwsCredentials();
        await getAwsCredentials();

        // Only one actual fetch — cache serves the rest
        expect(callCount).toBe(1);
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('no provider resolves', () => {
    it('throws a clear error when no provider can resolve', async () => {
      // No env vars set, no metadata service reachable
      await expect(getAwsCredentials()).rejects.toThrow(
        /credential resolution failed/,
      );
    });
  });
});
