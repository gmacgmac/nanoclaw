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
import fs from 'fs';
import path from 'path';

import {
  readEnvFile,
  scanEndpoints,
  scanWebSearchEndpoints,
  EndpointEntry,
} from './env.js';
import { logger } from './logger.js';
import { transcribeAudio } from './transcription.js';
import { createProxyPlugins } from './proxy-plugins/registry.js';
import './proxy-plugins/index.js'; // trigger self-registration

/**
 * Resolve an audio file path that may be a container path
 * (e.g. /workspace/group/media/file.ogg) to a host path.
 * Searches group directories when the container prefix is detected.
 */
function resolveAudioPath(audioPath: string): string {
  // Already a valid host path
  if (fs.existsSync(audioPath)) return audioPath;

  // Container path: /workspace/group/... → groups/{folder}/...
  const containerPrefix = '/workspace/group/';
  if (audioPath.startsWith(containerPrefix)) {
    const relative = audioPath.slice(containerPrefix.length);
    const groupsDir = path.join(process.cwd(), 'groups');
    try {
      const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(groupsDir, entry.name, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore read errors
    }
  }

  return audioPath;
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Header containers use to select an endpoint. */
export const ENDPOINT_HEADER = 'x-nanoclaw-endpoint';

/** Header containers use to select a web search vendor. */
export const WEB_SEARCH_VENDOR_HEADER = 'x-nanoclaw-web-search-vendor';

/** Default vendor when header is absent or vendor is unknown. */
const DEFAULT_VENDOR = 'anthropic';

/** Default web search vendor when header is absent. */
const DEFAULT_WEB_SEARCH_VENDOR = 'ollama';

/** Request paths that trigger web search routing instead of inference routing. */
const WEB_SEARCH_PATHS = ['/web_search', '/web_fetch'];

/**
 * Resolve the upstream URL and API key for a given vendor name.
 * Uses the multi-endpoint routing table first, then falls back to
 * legacy single-endpoint secrets for backward compatibility.
 */
function resolveEndpoint(
  vendor: string,
  routingTable: Record<string, EndpointEntry>,
  legacySecrets: Record<string, string>,
): {
  upstreamUrl: URL;
  apiKey: string | undefined;
  oauthToken: string | undefined;
  authMode: AuthMode;
} {
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
  const oauthToken =
    legacySecrets.CLAUDE_CODE_OAUTH_TOKEN || legacySecrets.ANTHROPIC_AUTH_TOKEN;
  return {
    upstreamUrl: new URL(
      legacySecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    ),
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

  // Build web search routing table from secrets.env
  const webSearchTable = scanWebSearchEndpoints();
  const webSearchVendors = Object.keys(webSearchTable);

  // Build proxy plugin instances (only active if credentials configured)
  const proxyPlugins = createProxyPlugins();
  if (proxyPlugins.length > 0) {
    logger.info(
      { plugins: proxyPlugins.map((p) => p.name) },
      'Proxy plugins loaded',
    );
  }

  // Legacy secrets for backward compatibility (OAuth, single-endpoint setups)
  const legacySecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Determine default auth mode from legacy secrets (used for logging)
  const defaultAuthMode: AuthMode = legacySecrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // --- Transcription endpoint ---
        if (req.url === '/transcribe' && req.method === 'POST') {
          try {
            const data = JSON.parse(body.toString()) as { audioPath?: string };
            if (!data.audioPath) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'audioPath is required' }));
              return;
            }
            const resolvedPath = resolveAudioPath(data.audioPath);
            const result = await transcribeAudio(resolvedPath);
            if (result.text) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ text: result.text }));
            } else {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: result.error || 'Transcription failed',
                }),
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err: msg }, 'Transcription endpoint error');
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          }
          return;
        }

        // --- Proxy plugins ---
        const matchedPlugin = proxyPlugins.find((p) =>
          p.pathPrefixes.some((prefix) => req.url?.startsWith(prefix)),
        );
        if (matchedPlugin) {
          try {
            const handled = await matchedPlugin.handle(req, res, body);
            if (handled) return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(
              { err: msg, plugin: matchedPlugin.name },
              'Proxy plugin error',
            );
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: msg }));
            }
            return;
          }
        }

        // Check if this is a web search request (path-based routing)
        const isWebSearch = WEB_SEARCH_PATHS.some(
          (p) => req.url === p || req.url?.startsWith(p + '?'),
        );

        if (isWebSearch) {
          const vendor = (
            (req.headers[WEB_SEARCH_VENDOR_HEADER] as string) ||
            DEFAULT_WEB_SEARCH_VENDOR
          ).toLowerCase();

          const wsEntry = webSearchTable[vendor];
          if (!wsEntry) {
            logger.warn(
              { vendor, available: webSearchVendors },
              'Web search vendor not found',
            );
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Web search vendor "${vendor}" not configured. Available: [${webSearchVendors.join(', ')}]`,
              }),
            );
            return;
          }

          const wsUpstream = new URL(wsEntry.baseUrl);
          const isHttps = wsUpstream.protocol === 'https:';
          const makeReq = isHttps ? httpsRequest : httpRequest;

          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: wsUpstream.host,
            'content-length': body.length,
            authorization: `Bearer ${wsEntry.apiKey}`,
          };

          // Strip hop-by-hop and routing headers
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];
          delete headers[WEB_SEARCH_VENDOR_HEADER];
          delete headers[ENDPOINT_HEADER];
          delete headers['x-api-key'];

          const basePath = wsUpstream.pathname.replace(/\/$/, '');
          const requestPath = basePath + req.url;

          logger.info(
            {
              method: req.method,
              path: req.url,
              vendor,
              upstream: wsUpstream.hostname,
            },
            'Proxy forwarding web search request',
          );

          const upstream = makeReq(
            {
              hostname: wsUpstream.hostname,
              port: wsUpstream.port || (isHttps ? 443 : 80),
              path: requestPath,
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
              { err, url: req.url, vendor },
              'Web search proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
          return;
        }

        // --- Inference routing (existing logic) ---
        const requestedVendor = (
          (req.headers[ENDPOINT_HEADER] as string) || DEFAULT_VENDOR
        ).toLowerCase();

        const { upstreamUrl, apiKey, oauthToken, authMode } = resolveEndpoint(
          requestedVendor,
          routingTable,
          legacySecrets,
        );

        logger.info(
          {
            endpointHeader: req.headers[ENDPOINT_HEADER],
            vendor: requestedVendor,
            upstreamUrl: upstreamUrl.toString(),
            authMode,
            hasApiKey: !!apiKey,
          },
          'Proxy routing request',
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
          // Strip any Authorization header from OAuth-style SDK requests
          delete headers['x-api-key'];
          delete headers['authorization'];
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

        // Combine base URL pathname with request path
        const basePath = upstreamUrl.pathname.replace(/\/$/, '');
        const requestPath = basePath + req.url;

        logger.info(
          {
            method: req.method,
            path: req.url,
            basePath,
            requestPath,
            upstreamHost: upstreamUrl.hostname,
            authMode,
            authHeader: req.headers['authorization'] ? 'present' : 'none',
            xApiKeyHeader: req.headers['x-api-key'] ? 'present' : 'none',
          },
          'Proxy forwarding request',
        );

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: requestPath,
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
        {
          port,
          host,
          authMode: defaultAuthMode,
          endpoints: vendorNames,
          webSearchEndpoints: webSearchVendors,
        },
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
