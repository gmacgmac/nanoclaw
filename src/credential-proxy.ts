/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Multi-endpoint routing:
 *   Containers send an X-Nanoclaw-Endpoint header (e.g. "ollama", "zai")
 *   to select which upstream to use. The proxy looks up the vendor in a
 *   routing table built from secrets.env ({VENDOR}_BASE_URL / {VENDOR}_API_KEY).
 *   Falls back to "anthropic" when the header is absent or the vendor is unknown.
 *
 * Auth modes (per-endpoint):
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile, scanEndpoints, EndpointEntry } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Header containers use to select an endpoint. */
export const ENDPOINT_HEADER = 'x-nanoclaw-endpoint';

/** Default vendor when header is absent or vendor is unknown. */
const DEFAULT_VENDOR = 'anthropic';

/**
 * Resolve the upstream URL and API key for a given vendor name.
 * Uses the multi-endpoint routing table first, then falls back to
 * legacy single-endpoint secrets for backward compatibility.
 */
function resolveEndpoint(
  vendor: string,
  routingTable: Record<string, EndpointEntry>,
  legacySecrets: Record<string, string>,
): { upstreamUrl: URL; apiKey: string | undefined; oauthToken: string | undefined; authMode: AuthMode } {
  const entry = routingTable[vendor] || routingTable[DEFAULT_VENDOR];

  if (entry) {
    return {
      upstreamUrl: new URL(entry.baseUrl),
      apiKey: entry.apiKey,
      oauthToken: undefined,
      authMode: 'api-key',
    };
  }

  // Legacy fallback: use the flat ANTHROPIC_* secrets
  const oauthToken = legacySecrets.CLAUDE_CODE_OAUTH_TOKEN || legacySecrets.ANTHROPIC_AUTH_TOKEN;
  return {
    upstreamUrl: new URL(legacySecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
    apiKey: legacySecrets.ANTHROPIC_API_KEY,
    oauthToken,
    authMode: legacySecrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth',
  };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Build multi-endpoint routing table from secrets.env
  const routingTable = scanEndpoints();
  const vendorNames = Object.keys(routingTable);

  // Legacy secrets for backward compatibility (OAuth, single-endpoint setups)
  const legacySecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Determine default auth mode from legacy secrets (used for logging)
  const defaultAuthMode: AuthMode = legacySecrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Determine which endpoint to route to
        const requestedVendor = (
          (req.headers[ENDPOINT_HEADER] as string) || DEFAULT_VENDOR
        ).toLowerCase();

        logger.debug(
          { endpointHeader: req.headers[ENDPOINT_HEADER], vendor: requestedVendor },
          'Proxy routing request',
        );

        const { upstreamUrl, apiKey, oauthToken, authMode } = resolveEndpoint(
          requestedVendor,
          routingTable,
          legacySecrets,
        );

        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = isHttps ? httpsRequest : httpRequest;

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Strip the routing header — upstream doesn't need it
        delete headers[ENDPOINT_HEADER];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = apiKey;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url, vendor: requestedVendor },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode: defaultAuthMode, endpoints: vendorNames },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
