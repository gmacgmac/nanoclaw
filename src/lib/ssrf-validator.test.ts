/**
 * BE_01: SSRF URL Validator — unit tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dnsPromises from 'dns/promises';

// Mock DNS so tests don't make real network calls
vi.mock('dns/promises', () => ({
  lookup: vi.fn(),
}));

const mockLookup = vi.mocked(dnsPromises.lookup);

// Helper: make DNS resolve to a given IP
function dnsResolves(ip: string) {
  mockLookup.mockResolvedValue({
    address: ip,
    family: ip.includes(':') ? 6 : 4,
  });
}

// Helper: make DNS fail
function dnsFails() {
  mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
}

import { validateUrl } from './ssrf-validator.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scheme validation
// ---------------------------------------------------------------------------
describe('scheme validation', () => {
  it('allows http://', async () => {
    dnsResolves('93.184.216.34');
    const r = await validateUrl('http://example.com/path');
    expect(r.allowed).toBe(true);
  });

  it('allows https://', async () => {
    dnsResolves('93.184.216.34');
    const r = await validateUrl('https://example.com/path');
    expect(r.allowed).toBe(true);
  });

  it('blocks file://', async () => {
    const r = await validateUrl('file:///etc/passwd');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/scheme/i);
  });

  it('blocks ftp://', async () => {
    const r = await validateUrl('ftp://example.com/file');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/scheme/i);
  });

  it('blocks gopher://', async () => {
    const r = await validateUrl('gopher://example.com');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/scheme/i);
  });

  it('blocks invalid URL', async () => {
    const r = await validateUrl('not-a-url');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/invalid url/i);
  });
});

// ---------------------------------------------------------------------------
// Cloud metadata hostnames
// ---------------------------------------------------------------------------
describe('cloud metadata hostnames', () => {
  it('blocks metadata.google.internal', async () => {
    const r = await validateUrl(
      'http://metadata.google.internal/computeMetadata/v1/',
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/metadata/i);
  });

  it('blocks metadata.goog', async () => {
    const r = await validateUrl('http://metadata.goog/');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blocked IPv4 ranges (direct IP in URL — no DNS needed)
// ---------------------------------------------------------------------------
describe('blocked IPv4 ranges — direct IP', () => {
  it('blocks loopback 127.0.0.1', async () => {
    const r = await validateUrl('http://127.0.0.1/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/loopback/i);
  });

  it('blocks loopback 127.255.255.255', async () => {
    const r = await validateUrl('http://127.255.255.255/');
    expect(r.allowed).toBe(false);
  });

  it('blocks AWS/GCP metadata 169.254.169.254', async () => {
    const r = await validateUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/link-local/i);
  });

  it('blocks RFC 1918 — 10.x.x.x', async () => {
    const r = await validateUrl('http://10.0.0.1/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/private/i);
  });

  it('blocks RFC 1918 — 172.16.x.x', async () => {
    const r = await validateUrl('http://172.16.0.1/');
    expect(r.allowed).toBe(false);
  });

  it('blocks RFC 1918 — 172.31.x.x (upper edge of /12)', async () => {
    const r = await validateUrl('http://172.31.255.255/');
    expect(r.allowed).toBe(false);
  });

  it('allows 172.32.0.0 (just outside /12)', async () => {
    dnsResolves('172.32.0.0'); // won't be called — direct IP
    mockLookup.mockResolvedValue({ address: '172.32.0.0', family: 4 });
    const r = await validateUrl('http://172.32.0.0/');
    expect(r.allowed).toBe(true);
  });

  it('blocks RFC 1918 — 192.168.x.x', async () => {
    const r = await validateUrl('http://192.168.1.1/');
    expect(r.allowed).toBe(false);
  });

  it('blocks CGNAT 100.64.0.1 (Tailscale range)', async () => {
    const r = await validateUrl('http://100.64.0.1/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cgnat/i);
  });

  it('blocks CGNAT 100.127.255.255 (upper edge of /10)', async () => {
    const r = await validateUrl('http://100.127.255.255/');
    expect(r.allowed).toBe(false);
  });

  it('allows 100.128.0.0 (just outside CGNAT /10)', async () => {
    mockLookup.mockResolvedValue({ address: '100.128.0.0', family: 4 });
    const r = await validateUrl('http://100.128.0.0/');
    expect(r.allowed).toBe(true);
  });

  it('blocks multicast 224.0.0.1', async () => {
    const r = await validateUrl('http://224.0.0.1/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/multicast/i);
  });

  it('blocks reserved 240.0.0.1', async () => {
    const r = await validateUrl('http://240.0.0.1/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/reserved/i);
  });
});

// ---------------------------------------------------------------------------
// Blocked IPv6 ranges — direct IP
// ---------------------------------------------------------------------------
describe('blocked IPv6 ranges — direct IP', () => {
  it('blocks ::1 (loopback)', async () => {
    const r = await validateUrl('http://[::1]/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/loopback/i);
  });

  it('blocks fe80::1 (link-local)', async () => {
    const r = await validateUrl('http://[fe80::1]/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/link-local/i);
  });

  it('blocks ff02::1 (multicast)', async () => {
    const r = await validateUrl('http://[ff02::1]/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/multicast/i);
  });

  it('blocks IPv6-mapped IPv4 ::ffff:192.168.1.1', async () => {
    const r = await validateUrl('http://[::ffff:192.168.1.1]/');
    expect(r.allowed).toBe(false);
  });

  it('blocks IPv6-mapped metadata ::ffff:169.254.169.254', async () => {
    const r = await validateUrl('http://[::ffff:169.254.169.254]/');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alternate IP encodings (bypass attempts)
// ---------------------------------------------------------------------------
describe('alternate IP encodings', () => {
  it('blocks octal-encoded loopback 0177.0.0.1', async () => {
    const r = await validateUrl('http://0177.0.0.1/');
    expect(r.allowed).toBe(false);
  });

  it('blocks hex-encoded loopback 0x7f.0.0.1', async () => {
    const r = await validateUrl('http://0x7f.0.0.1/');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS resolution
// ---------------------------------------------------------------------------
describe('DNS resolution', () => {
  it('blocks when DNS resolves to a private IP', async () => {
    dnsResolves('192.168.1.100');
    const r = await validateUrl('http://internal.corp.example.com/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/resolved ip/i);
  });

  it('blocks when DNS resolves to metadata IP', async () => {
    dnsResolves('169.254.169.254');
    const r = await validateUrl('http://sneaky-redirect.example.com/');
    expect(r.allowed).toBe(false);
  });

  it('allows when DNS resolves to a public IP', async () => {
    dnsResolves('93.184.216.34');
    const r = await validateUrl('https://example.com/');
    expect(r.allowed).toBe(true);
  });

  it('fails closed when DNS lookup throws', async () => {
    dnsFails();
    const r = await validateUrl('http://nonexistent.invalid/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/dns resolution failed/i);
  });
});

// ---------------------------------------------------------------------------
// Known-good public URLs
// ---------------------------------------------------------------------------
describe('public URLs', () => {
  it('allows Brave Search API', async () => {
    dnsResolves('185.235.41.65');
    const r = await validateUrl(
      'https://api.search.brave.com/res/v1/web/search?q=test',
    );
    expect(r.allowed).toBe(true);
  });

  it('allows generic HTTPS endpoint', async () => {
    dnsResolves('1.2.3.4');
    const r = await validateUrl('https://api.openai.com/v1/chat/completions');
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Options overrides
// ---------------------------------------------------------------------------
describe('SsrfValidatorOptions', () => {
  it('allowPrivateNetworks bypasses RFC 1918 block', async () => {
    const r = await validateUrl('http://192.168.1.1/', {
      allowPrivateNetworks: true,
    });
    expect(r.allowed).toBe(true);
  });

  it('allowPrivateNetworks bypasses loopback block', async () => {
    const r = await validateUrl('http://127.0.0.1/', {
      allowPrivateNetworks: true,
    });
    expect(r.allowed).toBe(true);
  });

  it('allowPrivateNetworks bypasses DNS-resolved private IP', async () => {
    dnsResolves('10.0.0.5');
    const r = await validateUrl('http://internal.example.com/', {
      allowPrivateNetworks: true,
    });
    expect(r.allowed).toBe(true);
  });

  it('additionalBlockedHosts blocks a public hostname', async () => {
    dnsResolves('93.184.216.34');
    const r = await validateUrl('https://example.com/', {
      additionalBlockedHosts: ['example.com'],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/additionalBlockedHosts/i);
  });

  it('additionalAllowedHosts bypasses blocklist for that host', async () => {
    // metadata.google.internal is normally blocked before DNS
    const r = await validateUrl('http://metadata.google.internal/', {
      additionalAllowedHosts: ['metadata.google.internal'],
    });
    expect(r.allowed).toBe(true);
  });

  it('additionalAllowedHosts takes priority over additionalBlockedHosts', async () => {
    dnsResolves('93.184.216.34');
    const r = await validateUrl('https://example.com/', {
      additionalBlockedHosts: ['example.com'],
      additionalAllowedHosts: ['example.com'],
    });
    expect(r.allowed).toBe(true);
  });
});
