import crypto from 'crypto';
import zlib from 'zlib';
import { request as httpsRequest, type RequestOptions } from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerProxyPlugin, type ProxyPlugin } from './registry.js';

/**
 * Sign a payload using the Uplynk HMAC-SHA256 protocol.
 * 1. Build message JSON with _owner, _timestamp, and optionally ...data
 * 2. Zlib deflate compress (level 9) — matches pako.deflate() default (zlib-wrapped)
 * 3. Base64 encode
 * 4. HMAC-SHA256 sign with API key
 * Returns { msg: base64String, sig: hexSignature }
 */
function signPayload(
  data: Record<string, unknown>,
  userId: string,
  apiKey: string,
): { msg: string; sig: string } {
  const message = {
    _owner: userId,
    _timestamp: Math.floor(Date.now() / 1000),
    ...data,
  };

  const msgString = JSON.stringify(message);
  // pako.deflate() = zlib-wrapped (2-byte header + compressed data + 4-byte checksum).
  // pako.deflateRaw() would be raw. The reference uses pako.deflate → use deflateSync.
  const deflated = zlib.deflateSync(Buffer.from(msgString), { level: 9 });
  const base64Msg = deflated.toString('base64').trim();
  const signature = crypto
    .createHmac('sha256', apiKey)
    .update(base64Msg)
    .digest('hex');

  return { msg: base64Msg, sig: signature };
}

/**
 * Sign auth-only payload for POST/PATCH on v3/v4 endpoints.
 * The reference signs ONLY { _owner, _timestamp } (no request data)
 * and sends data as a separate JSON body.
 */
function signAuthOnly(
  userId: string,
  apiKey: string,
): { msg: string; sig: string } {
  return signPayload({}, userId, apiKey);
}

class UplynkProxyPlugin implements ProxyPlugin {
  name = 'uplynk';
  pathPrefixes = ['/uplynk/'];

  constructor(
    private userId: string,
    private apiKey: string,
  ) {}

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<boolean> {
    // Strip the /uplynk prefix to get the real API path
    const apiPath = req.url!.replace(/^\/uplynk/, '');
    if (!apiPath) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing API path after /uplynk/' }));
      return true;
    }

    // Parse request body as JSON (agent sends plain JSON)
    let data: Record<string, unknown> = {};
    if (body.length > 0) {
      try {
        data = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return true;
      }
    }

    const method = (req.method || 'GET').toUpperCase();

    // Detect API version from path to choose signing strategy.
    // v3/v4 POST/PATCH: sign auth-only, data as JSON body.
    // v2 POST: sign { _owner, _timestamp, ...data }, send as form-encoded body.
    // GET/DELETE: same for all versions — sign everything into query string.
    const isV3V4 = apiPath.includes('/api/v3') || apiPath.includes('/api/v4');

    // Build query string manually with encodeURIComponent to match the reference.
    // URL.searchParams.set() uses different encoding that Uplynk rejects.

    let upstreamBody: string | undefined;
    let queryString: string;
    const headers: Record<string, string | number> = {};

    if (method === 'GET' || method === 'DELETE') {
      // All versions: sign { _owner, _timestamp, ...data }, put msg+sig in query string.
      // Do NOT send a body — Uplynk rejects GET requests with a body.
      const { msg, sig } = signPayload(data, this.userId, this.apiKey);
      queryString = `msg=${encodeURIComponent(msg)}&sig=${encodeURIComponent(sig)}`;
    } else if (isV3V4) {
      // v3/v4 POST/PATCH: sign auth-only { _owner, _timestamp }, put msg+sig
      // in query string, send data as JSON body.
      const { msg, sig } = signAuthOnly(this.userId, this.apiKey);
      queryString = `msg=${encodeURIComponent(msg)}&sig=${sig}`;
      upstreamBody = JSON.stringify(data);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(upstreamBody);
    } else {
      // v2 POST: sign { _owner, _timestamp, ...data }, send as form-encoded body.
      const { msg, sig } = signPayload(data, this.userId, this.apiKey);
      upstreamBody = `msg=${encodeURIComponent(msg)}&sig=${encodeURIComponent(sig)}`;
      headers['content-length'] = Buffer.byteLength(upstreamBody);
      queryString = '';
    }

    logger.info(
      {
        method,
        path: apiPath,
        upstream: 'services.uplynk.com',
        plugin: this.name,
      },
      'Proxy plugin forwarding request',
    );

    const upstreamPath = queryString ? `${apiPath}?${queryString}` : apiPath;

    return new Promise<boolean>((resolve) => {
      const upstreamReq = httpsRequest(
        {
          hostname: 'services.uplynk.com',
          port: 443,
          path: upstreamPath,
          method,
          headers,
        } as RequestOptions,
        (upRes) => {
          res.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(res);
          resolve(true);
        },
      );

      upstreamReq.on('error', (err) => {
        logger.error(
          { err: err.message, path: apiPath, plugin: this.name },
          'Uplynk upstream error',
        );
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `Uplynk upstream error: ${err.message}`,
            }),
          );
        }
        resolve(true);
      });

      if (upstreamBody) {
        upstreamReq.write(upstreamBody);
      }
      upstreamReq.end();
    });
  }
}

registerProxyPlugin('uplynk', () => {
  const secrets = readEnvFile(['UPLYNK_USERID', 'UPLYNK_API_KEY']);
  if (!secrets.UPLYNK_USERID || !secrets.UPLYNK_API_KEY) {
    return null; // Not configured — plugin inactive
  }
  return new UplynkProxyPlugin(secrets.UPLYNK_USERID, secrets.UPLYNK_API_KEY);
});
