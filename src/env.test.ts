import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { scanEndpoints, scanWebSearchEndpoints } from './env.js';

// Mock fs.readFileSync so we never touch real files
vi.mock('fs');

// Mock logger used by scanEndpoints for auth validation warnings
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const HOME = '/mock/home';

describe('scanWebSearchEndpoints', () => {
  const secretsPath = path.join(HOME, '.config', 'nanoclaw', 'secrets.env');
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, HOME };
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/mock/project');
  });

  afterEach(() => {
    process.env = originalEnv;
    cwdSpy.mockRestore();
  });

  function mockFiles(files: Record<string, string>) {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const filePath = String(p);
      if (files[filePath] !== undefined) return files[filePath];
      throw new Error(`ENOENT: ${filePath}`);
    });
  }

  it('discovers a valid web search endpoint pair from secrets.env', () => {
    mockFiles({
      [secretsPath]: [
        'OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api',
        'OLLAMA_WEB_SEARCH_API_KEY=ollama-xxx',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({
      ollama: { baseUrl: 'https://ollama.com/api', apiKey: 'ollama-xxx' },
    });
  });

  it('strips quotes from values', () => {
    mockFiles({
      [secretsPath]: [
        'OLLAMA_WEB_SEARCH_BASE_URL="https://ollama.com/api"',
        "OLLAMA_WEB_SEARCH_API_KEY='ollama-xxx'",
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({
      ollama: { baseUrl: 'https://ollama.com/api', apiKey: 'ollama-xxx' },
    });
  });

  it('skips entries missing the API key', () => {
    mockFiles({
      [secretsPath]: 'OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api\n',
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({});
  });

  it('skips entries missing the base URL', () => {
    mockFiles({
      [secretsPath]: 'OLLAMA_WEB_SEARCH_API_KEY=ollama-xxx\n',
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({});
  });

  it('secrets.env takes priority over .env', () => {
    const envPath = path.join('/mock/project', '.env');
    mockFiles({
      [envPath]: [
        'OLLAMA_WEB_SEARCH_BASE_URL=https://env-url.com',
        'OLLAMA_WEB_SEARCH_API_KEY=env-key',
      ].join('\n'),
      [secretsPath]: [
        'OLLAMA_WEB_SEARCH_BASE_URL=https://secrets-url.com',
        'OLLAMA_WEB_SEARCH_API_KEY=secrets-key',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    // secrets.env is read second, so it overwrites .env values
    expect(result).toEqual({
      ollama: { baseUrl: 'https://secrets-url.com', apiKey: 'secrets-key' },
    });
  });

  it('discovers multiple vendors', () => {
    mockFiles({
      [secretsPath]: [
        'OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api',
        'OLLAMA_WEB_SEARCH_API_KEY=ollama-key',
        'BRAVE_WEB_SEARCH_BASE_URL=https://api.search.brave.com',
        'BRAVE_WEB_SEARCH_API_KEY=brave-key',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({
      ollama: { baseUrl: 'https://ollama.com/api', apiKey: 'ollama-key' },
      brave: {
        baseUrl: 'https://api.search.brave.com',
        apiKey: 'brave-key',
      },
    });
  });

  it('lowercases vendor names', () => {
    mockFiles({
      [secretsPath]: [
        'MY_VENDOR_WEB_SEARCH_BASE_URL=https://example.com',
        'MY_VENDOR_WEB_SEARCH_API_KEY=key123',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result['my_vendor']).toBeDefined();
    expect(result['MY_VENDOR']).toBeUndefined();
  });

  it('skips comments and blank lines', () => {
    mockFiles({
      [secretsPath]: [
        '# This is a comment',
        '',
        '   ',
        'OLLAMA_WEB_SEARCH_BASE_URL=https://ollama.com/api',
        '# Another comment',
        'OLLAMA_WEB_SEARCH_API_KEY=ollama-xxx',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({
      ollama: { baseUrl: 'https://ollama.com/api', apiKey: 'ollama-xxx' },
    });
  });

  it('falls back to process.env when no files exist', () => {
    mockFiles({});
    process.env['OLLAMA_WEB_SEARCH_BASE_URL'] = 'https://from-env.com';
    process.env['OLLAMA_WEB_SEARCH_API_KEY'] = 'env-api-key';

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({
      ollama: { baseUrl: 'https://from-env.com', apiKey: 'env-api-key' },
    });

    delete process.env['OLLAMA_WEB_SEARCH_BASE_URL'];
    delete process.env['OLLAMA_WEB_SEARCH_API_KEY'];
  });

  it('returns empty object when no web search endpoints configured', () => {
    mockFiles({});
    const result = scanWebSearchEndpoints();
    expect(result).toEqual({});
  });

  it('does not pick up regular (non-web-search) endpoint pairs', () => {
    mockFiles({
      [secretsPath]: [
        'OLLAMA_BASE_URL=https://ollama.com/v1',
        'OLLAMA_API_KEY=inference-key',
      ].join('\n'),
    });

    const result = scanWebSearchEndpoints();
    expect(result).toEqual({});
  });
});


describe('scanEndpoints', () => {
  const secretsPath = path.join(HOME, '.config', 'nanoclaw', 'secrets.env');
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, HOME };
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/mock/project');
  });

  afterEach(() => {
    process.env = originalEnv;
    cwdSpy.mockRestore();
  });

  function mockFiles(files: Record<string, string>) {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const filePath = String(p);
      if (files[filePath] !== undefined) return files[filePath];
      throw new Error(`ENOENT: ${filePath}`);
    });
  }

  it('discovers a standard vendor with base URL + API key (auth undefined)', () => {
    mockFiles({
      [secretsPath]: [
        'ANTHROPIC_BASE_URL=https://api.anthropic.com',
        'ANTHROPIC_API_KEY=sk-ant-123',
      ].join('\n'),
    });

    const result = scanEndpoints();
    expect(result).toEqual({
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-123',
      },
    });
    // auth and region should be absent (default behavior preserved)
    expect(result['anthropic'].auth).toBeUndefined();
    expect(result['anthropic'].region).toBeUndefined();
  });

  it('parses _AUTH=bearer into auth field', () => {
    mockFiles({
      [secretsPath]: [
        'BEDROCK_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com',
        'BEDROCK_API_KEY=bedrock-key-123',
        'BEDROCK_AUTH=bearer',
      ].join('\n'),
    });

    const result = scanEndpoints();
    expect(result['bedrock']).toEqual({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      apiKey: 'bedrock-key-123',
      auth: 'bearer',
    });
  });

  it('includes sigv4 vendor with no API key when _AUTH=sigv4', () => {
    mockFiles({
      [secretsPath]: [
        'BEDROCK_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com',
        'BEDROCK_AUTH=sigv4',
        'BEDROCK_REGION=us-east-1',
      ].join('\n'),
    });

    const result = scanEndpoints();
    expect(result['bedrock']).toEqual({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      auth: 'sigv4',
      region: 'us-east-1',
    });
    expect(result['bedrock'].apiKey).toBeUndefined();
  });

  it('warns and omits auth for invalid _AUTH value (entry still present if key exists)', async () => {
    const { logger } = await import('./logger.js');
    mockFiles({
      [secretsPath]: [
        'MYVENDOR_BASE_URL=https://example.com',
        'MYVENDOR_API_KEY=my-key',
        'MYVENDOR_AUTH=bogus',
      ].join('\n'),
    });

    const result = scanEndpoints();
    // Entry is present (has base + key) but auth is undefined
    expect(result['myvendor']).toEqual({
      baseUrl: 'https://example.com',
      apiKey: 'my-key',
    });
    expect(result['myvendor'].auth).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { vendor: 'myvendor', value: 'bogus' },
      expect.stringContaining('Invalid _AUTH value'),
    );
  });

  it('skips vendor with base URL only, no key, no sigv4 (unchanged behavior)', () => {
    mockFiles({
      [secretsPath]: [
        'ORPHAN_BASE_URL=https://orphan.example.com',
      ].join('\n'),
    });

    const result = scanEndpoints();
    expect(result['orphan']).toBeUndefined();
  });

  it('normalizes _AUTH to lowercase', () => {
    mockFiles({
      [secretsPath]: [
        'BEDROCK_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com',
        'BEDROCK_API_KEY=key-123',
        'BEDROCK_AUTH=Bearer',
      ].join('\n'),
    });

    const result = scanEndpoints();
    expect(result['bedrock'].auth).toBe('bearer');
  });

  it('reads _AUTH and _REGION from process.env fallback', () => {
    mockFiles({});
    process.env['BEDROCK_BASE_URL'] = 'https://bedrock-runtime.us-east-1.amazonaws.com';
    process.env['BEDROCK_AUTH'] = 'sigv4';
    process.env['BEDROCK_REGION'] = 'us-west-2';

    const result = scanEndpoints();
    expect(result['bedrock']).toEqual({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      auth: 'sigv4',
      region: 'us-west-2',
    });

    delete process.env['BEDROCK_BASE_URL'];
    delete process.env['BEDROCK_AUTH'];
    delete process.env['BEDROCK_REGION'];
  });
});
