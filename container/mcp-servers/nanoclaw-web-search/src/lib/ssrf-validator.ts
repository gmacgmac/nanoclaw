/**
 * SSRF Protection — URL Validator (MCP Server Copy)
 *
 * Validates outbound URLs to prevent Server-Side Request Forgery attacks.
 * Blocks requests to internal networks, cloud metadata endpoints, and
 * dangerous schemes. Fail-closed on DNS failure.
 *
 * IMPORTANT: This is a copy of src/lib/ssrf-validator.ts from the host codebase.
 * The MCP server runs inside the container as a self-contained package and cannot
 * import from the host's src/lib/ at runtime.
 *
 * Source of truth: src/lib/ssrf-validator.ts (BE_01)
 */
import { lookup } from 'dns/promises';

export interface SsrfValidatorOptions {
  /** Allow private/internal networks (default: false) */
  allowPrivateNetworks?: boolean;
  /** Additional hostnames or IPs to block */
  additionalBlockedHosts?: string[];
  /** Exceptions — hosts that bypass the blocklist */
  additionalAllowedHosts?: string[];
}

export interface SsrfValidationResult {
  allowed: boolean;
  reason?: string;
}

/** Schemes that are allowed through */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Cloud metadata hostnames — blocked regardless of resolved IP */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data', // OpenStack
  'computeMetadata', // GCP legacy
]);

/**
 * Parse an IPv4 address string into a 32-bit integer.
 * Handles dotted-decimal, decimal, octal, and hex encodings.
 * Returns null if not a valid IPv4 address.
 */
function parseIpv4(ip: string): number | null {
  // Normalise: strip IPv6-mapped IPv4 prefix (::ffff:x.x.x.x or ::ffff:hex)
  const mapped = ip.match(/^::ffff:(.+)$/i);
  if (mapped) ip = mapped[1];

  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    let val: number;
    if (part.startsWith('0x') || part.startsWith('0X')) {
      val = parseInt(part, 16);
    } else if (part.startsWith('0') && part.length > 1) {
      val = parseInt(part, 8); // octal
    } else {
      val = parseInt(part, 10);
    }
    if (isNaN(val) || val < 0 || val > 255) return null;
    result = (result << 8) | val;
  }
  return result >>> 0; // unsigned 32-bit
}

/**
 * Check if an IPv4 integer falls within a CIDR block.
 */
function inCidr(ip: number, cidrBase: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (cidrBase & mask);
}

/** Pre-parsed blocked IPv4 CIDR ranges */
const BLOCKED_IPV4_CIDRS: Array<{ base: number; prefix: number; label: string }> = [
  { base: parseIpv4('127.0.0.0')!, prefix: 8,  label: 'loopback (127.0.0.0/8)' },
  { base: parseIpv4('10.0.0.0')!,  prefix: 8,  label: 'private (10.0.0.0/8)' },
  { base: parseIpv4('172.16.0.0')!, prefix: 12, label: 'private (172.16.0.0/12)' },
  { base: parseIpv4('192.168.0.0')!, prefix: 16, label: 'private (192.168.0.0/16)' },
  { base: parseIpv4('169.254.0.0')!, prefix: 16, label: 'link-local (169.254.0.0/16)' },
  { base: parseIpv4('100.64.0.0')!, prefix: 10, label: 'CGNAT (100.64.0.0/10)' },
  { base: parseIpv4('0.0.0.0')!,   prefix: 8,  label: 'unspecified (0.0.0.0/8)' },
  { base: parseIpv4('224.0.0.0')!, prefix: 4,  label: 'multicast (224.0.0.0/4)' },
  { base: parseIpv4('240.0.0.0')!, prefix: 4,  label: 'reserved (240.0.0.0/4)' },
];

/**
 * Convert a hex IPv6 group pair (e.g. "c0a8") to two decimal octets.
 */
function hexGroupToOctets(hex: string): [number, number] {
  const val = parseInt(hex, 16);
  return [(val >> 8) & 0xff, val & 0xff];
}

/**
 * Expand an IPv6-mapped IPv4 address in hex notation (::ffff:c0a8:101)
 * into a dotted-decimal string (192.168.1.1).
 */
function expandMappedIpv4(lower: string): string | null {
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const [a, b] = hexGroupToOctets(hexMatch[1].padStart(4, '0'));
    const [c, d] = hexGroupToOctets(hexMatch[2].padStart(4, '0'));
    return `${a}.${b}.${c}.${d}`;
  }
  const dotMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotMatch) return dotMatch[1];
  return null;
}

/**
 * Check if an IPv6 address is blocked.
 */
function isBlockedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    return 'loopback (::1)';
  }

  const mappedIp = expandMappedIpv4(lower);
  if (mappedIp !== null) {
    return isBlockedIpv4(mappedIp);
  }

  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) {
    return 'link-local IPv6 (fe80::/10)';
  }

  if (lower.startsWith('ff')) {
    return 'multicast IPv6 (ff00::/8)';
  }

  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    return 'unspecified IPv6 (::)';
  }

  return null;
}

/**
 * Check if an IPv4 address string is in a blocked range.
 */
function isBlockedIpv4(ip: string): string | null {
  const parsed = parseIpv4(ip);
  if (parsed === null) return null;

  for (const cidr of BLOCKED_IPV4_CIDRS) {
    if (inCidr(parsed, cidr.base, cidr.prefix)) {
      return cidr.label;
    }
  }
  return null;
}

/**
 * Validate a URL against the SSRF blocklist.
 *
 * Performs:
 * 1. Scheme check (only http/https allowed)
 * 2. Hostname blocklist check (cloud metadata hostnames)
 * 3. DNS resolution → IP blocklist check (fail-closed on DNS failure)
 * 4. Options overrides (allowPrivateNetworks, additionalBlockedHosts/AllowedHosts)
 */
export async function validateUrl(
  url: string,
  options: SsrfValidatorOptions = {},
): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  // 1. Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Check additionalAllowedHosts first (explicit exceptions)
  if (options.additionalAllowedHosts?.some((h) => h.toLowerCase() === hostname)) {
    return { allowed: true };
  }

  // 3. Check additionalBlockedHosts
  if (options.additionalBlockedHosts?.some((h) => h.toLowerCase() === hostname)) {
    return { allowed: false, reason: `Blocked by additionalBlockedHosts: ${hostname}` };
  }

  // 4. Cloud metadata hostname check (before DNS — these are always blocked)
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Blocked cloud metadata hostname: ${hostname}` };
  }

  // 5. If it looks like a bare IP, check it directly (no DNS needed)
  const directIpv4Block = isBlockedIpv4(hostname);
  if (directIpv4Block !== null) {
    if (options.allowPrivateNetworks) return { allowed: true };
    return { allowed: false, reason: `Blocked IP range: ${directIpv4Block}` };
  }

  const directIpv6Block = isBlockedIpv6(hostname);
  if (directIpv6Block !== null) {
    if (options.allowPrivateNetworks) return { allowed: true };
    return { allowed: false, reason: `Blocked IP range: ${directIpv6Block}` };
  }

  // 6. DNS resolution — fail-closed
  let resolvedAddress: string;
  try {
    const result = await lookup(hostname, { verbatim: false });
    resolvedAddress = result.address;
  } catch {
    return { allowed: false, reason: 'DNS resolution failed (fail-closed)' };
  }

  // 7. Check resolved IP
  const resolvedIpv4Block = isBlockedIpv4(resolvedAddress);
  if (resolvedIpv4Block !== null) {
    if (options.allowPrivateNetworks) return { allowed: true };
    return { allowed: false, reason: `Resolved IP in blocked range: ${resolvedIpv4Block} (${resolvedAddress})` };
  }

  const resolvedIpv6Block = isBlockedIpv6(resolvedAddress);
  if (resolvedIpv6Block !== null) {
    if (options.allowPrivateNetworks) return { allowed: true };
    return { allowed: false, reason: `Resolved IP in blocked range: ${resolvedIpv6Block} (${resolvedAddress})` };
  }

  return { allowed: true };
}
