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

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<boolean> {
    // Read credentials fresh per-request (no restart needed on key rotation)
    const secrets = readEnvFile(['UPLYNK_USERID', 'UPLYNK_API_KEY']);
    const userId = secrets.UPLYNK_USERID;
    const apiKey = secrets.UPLYNK_API_KEY;
    if (!userId || !apiKey) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Uplynk credentials not configured' }));
      return true;
    }

    // Strip the /uplynk prefix and separate path from query string
    const rawPath = req.url!.replace(/^\/uplynk/, '');
    const qIdx = rawPath.indexOf('?');
    const apiPath = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
    const incomingParams: Record<string, unknown> = {};
    if (qIdx >= 0) {
      const qs = rawPath.slice(qIdx + 1);
      for (const pair of qs.split('&')) {
        const eqIdx = pair.indexOf('=');
        const k = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
        const v = eqIdx >= 0 ? pair.slice(eqIdx + 1) : '';
        if (k) {
          const decoded = decodeURIComponent(v);
          // Coerce numeric strings to numbers (Uplynk expects typed JSON values)
          const asNum = Number(decoded);
          incomingParams[decodeURIComponent(k)] =
            decoded !== '' && !isNaN(asNum) ? asNum : decoded;
        }
      }
    }

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

    // Merge URL query params into data (body params win on conflict)
    data = { ...incomingParams, ...data };

    const method = (req.method || 'GET').toUpperCase();

    // Detect API version from path to choose signing strategy.
    // v3/v4: sign auth-only { _owner, _timestamp } for all methods.
    //   GET/DELETE: data params as plain query string alongside msg+sig.
    //   POST/PATCH: data as JSON body, msg+sig in query string.
    // v2 GET/DELETE: sign { _owner, _timestamp, ...data }, put msg+sig in query string.
    // v2 POST: sign { _owner, _timestamp, ...data }, send as form-encoded body.
    const isV3V4 = apiPath.includes('/api/v3') || apiPath.includes('/api/v4');

    // Build query string manually with encodeURIComponent to match the reference.
    // URL.searchParams.set() uses different encoding that Uplynk rejects.

    let upstreamBody: string | undefined;
    let queryString: string;
    const headers: Record<string, string | number> = {};

    if (method === 'GET' || method === 'DELETE') {
      if (isV3V4) {
        // v3/v4 GET/DELETE: sign auth-only { _owner, _timestamp }, pass data params
        // as plain query string alongside msg+sig.
        const { msg, sig } = signAuthOnly(userId, apiKey);
        const parts: string[] = [];
        for (const [k, v] of Object.entries(data)) {
          parts.push(
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          );
        }
        parts.push(`msg=${encodeURIComponent(msg)}`);
        parts.push(`sig=${encodeURIComponent(sig)}`);
        queryString = parts.join('&');
      } else {
        // v2 GET/DELETE: sign { _owner, _timestamp, ...data }, put msg+sig in query string.
        // Do NOT send a body — Uplynk rejects GET requests with a body.
        const { msg, sig } = signPayload(data, userId, apiKey);
        queryString = `msg=${encodeURIComponent(msg)}&sig=${encodeURIComponent(sig)}`;
      }
    } else if (isV3V4) {
      // v3/v4 POST/PATCH: sign auth-only { _owner, _timestamp }, put msg+sig
      // in query string, send data as JSON body.
      const { msg, sig } = signAuthOnly(userId, apiKey);
      queryString = `msg=${encodeURIComponent(msg)}&sig=${sig}`;
      upstreamBody = JSON.stringify(data);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(upstreamBody);
    } else {
      // v2 POST: sign { _owner, _timestamp, ...data }, send as form-encoded body.
      const { msg, sig } = signPayload(data, userId, apiKey);
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
  return new UplynkProxyPlugin();
});
