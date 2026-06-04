/**
 * AWS credential provider chain for host-side SigV4 signing.
 * Resolves temporary IAM-role credentials (or static keys for dev).
 * Chain order: static env → container credentials → EC2 IMDSv2.
 *
 * No import-time side effects. No network calls until getAwsCredentials() is invoked.
 * No external dependencies — uses Node built-in http.
 */
import http from 'http';
import type { AwsCredentials } from './aws-sigv4.js';
import { readEnvFile } from './env.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CredentialProvider {
  name: string;
  /** Resolve creds, or null if this provider is not applicable in this environment. */
  resolve(): Promise<(AwsCredentials & { expiresAt?: number }) | null>;
}

interface CachedCredentials {
  credentials: AwsCredentials;
  expiresAt?: number; // epoch ms; undefined = never expires (static env)
}

// ─── Cache ──────────────────────────────────────────────────────────────────

/** Refresh 5 minutes before expiry. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

let cached: CachedCredentials | null = null;

function isCacheValid(): boolean {
  if (!cached) return false;
  if (!cached.expiresAt) return true; // static creds never expire
  return Date.now() < cached.expiresAt - REFRESH_WINDOW_MS;
}

/** Clear the credential cache (for testing). */
export function clearCredentialCache(): void {
  cached = null;
}

// ─── HTTP helper ────────────────────────────────────────────────────────────

interface HttpGetOptions {
  url: string;
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
}

function httpFetch(
  opts: HttpGetOptions,
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const parsed = new URL(opts.url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: opts.timeoutMs ?? 2000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// ─── Provider 1: Static environment ─────────────────────────────────────────

const staticEnvProvider: CredentialProvider = {
  name: 'static-env',
  async resolve() {
    // Check secrets.env + process.env via readEnvFile
    const vars = readEnvFile([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]);
    const accessKeyId = vars.AWS_ACCESS_KEY_ID;
    const secretAccessKey = vars.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return null;
    const creds: AwsCredentials & { expiresAt?: number } = {
      accessKeyId,
      secretAccessKey,
    };
    if (vars.AWS_SESSION_TOKEN) creds.sessionToken = vars.AWS_SESSION_TOKEN;
    // Static creds: no expiry
    return creds;
  },
};

// ─── Provider 2: ECS / EKS container credentials ────────────────────────────

const containerCredsProvider: CredentialProvider = {
  name: 'container-credentials',
  async resolve() {
    const relativeUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    if (!relativeUri && !fullUri) return null;

    const url = fullUri || `http://169.254.170.2${relativeUri}`;

    // Auth token (EKS Pod Identity / full URI scenarios)
    const headers: Record<string, string> = {};
    const authTokenFile = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
    const authToken = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (authTokenFile) {
      try {
        const { readFileSync } = await import('fs');
        headers['Authorization'] = readFileSync(authTokenFile, 'utf-8').trim();
      } catch {
        // fall through — try without auth
      }
    } else if (authToken) {
      headers['Authorization'] = authToken;
    }

    const resp = await httpFetch({ url, headers, timeoutMs: 3000 });
    if (!resp || resp.status !== 200) return null;

    try {
      const data = JSON.parse(resp.body) as {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        Token?: string;
        Expiration?: string;
      };
      if (!data.AccessKeyId || !data.SecretAccessKey) return null;
      return {
        accessKeyId: data.AccessKeyId,
        secretAccessKey: data.SecretAccessKey,
        sessionToken: data.Token || undefined,
        expiresAt: data.Expiration
          ? new Date(data.Expiration).getTime()
          : undefined,
      };
    } catch {
      return null;
    }
  },
};

// ─── Provider 3: EC2 IMDSv2 ─────────────────────────────────────────────────

const IMDS_BASE = 'http://169.254.169.254';
const IMDS_TOKEN_TTL = '21600';

const imdsProvider: CredentialProvider = {
  name: 'ec2-imdsv2',
  async resolve() {
    // Step 1: Get IMDSv2 token
    const tokenResp = await httpFetch({
      url: `${IMDS_BASE}/latest/api/token`,
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': IMDS_TOKEN_TTL },
      timeoutMs: 1000,
    });
    if (!tokenResp || tokenResp.status !== 200 || !tokenResp.body) return null;
    const token = tokenResp.body.trim();

    // Step 2: Get role name
    const roleResp = await httpFetch({
      url: `${IMDS_BASE}/latest/meta-data/iam/security-credentials/`,
      headers: { 'X-aws-ec2-metadata-token': token },
      timeoutMs: 1000,
    });
    if (!roleResp || roleResp.status !== 200 || !roleResp.body) return null;
    const roleName = roleResp.body.trim().split('\n')[0];
    if (!roleName) return null;

    // Step 3: Get credentials for role
    const credsResp = await httpFetch({
      url: `${IMDS_BASE}/latest/meta-data/iam/security-credentials/${roleName}`,
      headers: { 'X-aws-ec2-metadata-token': token },
      timeoutMs: 2000,
    });
    if (!credsResp || credsResp.status !== 200) return null;

    try {
      const data = JSON.parse(credsResp.body) as {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        Token?: string;
        Expiration?: string;
      };
      if (!data.AccessKeyId || !data.SecretAccessKey) return null;
      return {
        accessKeyId: data.AccessKeyId,
        secretAccessKey: data.SecretAccessKey,
        sessionToken: data.Token || undefined,
        expiresAt: data.Expiration
          ? new Date(data.Expiration).getTime()
          : undefined,
      };
    } catch {
      return null;
    }
  },
};

// ─── Provider chain ordering ─────────────────────────────────────────────────
// Future: IRSA (web-identity → STS AssumeRoleWithWebIdentity) would slot in
// between container-credentials and ec2-imdsv2 here. Not implemented — see PLAN
// "Out of Scope" / Open Questions.

const providers: CredentialProvider[] = [
  staticEnvProvider,
  containerCredsProvider,
  // TODO: IRSA provider would go here (EKS web identity → STS)
  imdsProvider,
];

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Returns cached AWS credentials, refreshing when expired.
 * Tries providers in order; first non-null wins.
 * Throws if no provider can resolve credentials.
 */
export async function getAwsCredentials(): Promise<AwsCredentials> {
  if (isCacheValid()) return cached!.credentials;

  for (const provider of providers) {
    const result = await provider.resolve();
    if (result) {
      const { expiresAt, ...credentials } = result;
      cached = { credentials, expiresAt };
      return credentials;
    }
  }

  throw new Error(
    'AWS credential resolution failed: no provider could resolve credentials. ' +
      'Ensure AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are set, or the host has an ' +
      'IAM role (ECS task role / EC2 instance profile).',
  );
}
