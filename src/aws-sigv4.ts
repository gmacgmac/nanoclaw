import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: URL; // host + path + query
  headers: Record<string, string>; // outbound headers (host, content-type, etc.)
  body: Buffer; // fully buffered payload
  region: string;
  service: string; // 'bedrock' for bedrock-runtime
  credentials: AwsCredentials;
  date?: Date; // injectable for deterministic tests
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * URI-encode per RFC 3986 (AWS variant: encode everything except unreserved).
 * Unreserved = A-Z a-z 0-9 - _ . ~
 */
function uriEncode(value: string, encodeSlash = true): string {
  let encoded = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-' ||
      ch === '_' ||
      ch === '.' ||
      ch === '~'
    ) {
      encoded += ch;
    } else if (ch === '/' && !encodeSlash) {
      encoded += '/';
    } else {
      // Percent-encode each byte of the UTF-8 representation
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) {
        encoded += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return encoded;
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function formatDateStamp(date: Date): string {
  return formatAmzDate(date).slice(0, 8);
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Sign a fully-buffered HTTP request using AWS Signature Version 4.
 * Returns headers to ADD to the outbound request (does not mutate input).
 */
export function signRequestV4(input: SignInput): Record<string, string> {
  const { method, url, body, region, service, credentials } = input;
  const now = input.date ?? new Date();

  const amzDate = formatAmzDate(now);
  const dateStamp = formatDateStamp(now);

  // Payload hash
  const payloadHash = sha256Hex(body);

  // Build the set of headers to sign (merge input headers + generated ones)
  const headersToSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    headersToSign[k.toLowerCase()] = v.trim();
  }
  headersToSign['x-amz-date'] = amzDate;
  headersToSign['x-amz-content-sha256'] = payloadHash;
  if (credentials.sessionToken) {
    headersToSign['x-amz-security-token'] = credentials.sessionToken;
  }
  // Ensure host is present
  if (!headersToSign['host']) {
    headersToSign['host'] = url.host;
  }

  // Sorted signed header names
  const sortedHeaderNames = Object.keys(headersToSign).sort();
  const signedHeaders = sortedHeaderNames.join(';');

  // Canonical headers
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${headersToSign[name]}\n`)
    .join('');

  // Canonical URI: encode each path segment, preserve slashes
  const canonicalUri = uriEncode(url.pathname, false) || '/';

  // Canonical query string: sort by key, encode key+value
  const canonicalQueryString = buildCanonicalQueryString(url.searchParams);

  // Canonical request
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Credential scope
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // String to sign
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing key
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');

  // Signature
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');

  // Authorization header
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Return only the headers to add
  const result: Record<string, string> = {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken) {
    result['x-amz-security-token'] = credentials.sessionToken;
  }
  return result;
}

/**
 * Build canonical query string: sort params by key, encode per AWS rules.
 */
function buildCanonicalQueryString(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  params.forEach((value, key) => {
    pairs.push([uriEncode(key), uriEncode(value)]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}
