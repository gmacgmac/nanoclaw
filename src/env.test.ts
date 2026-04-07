import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { scanWebSearchEndpoints } from './env.js';

// Mock fs.readFileSync so we never touch real files
vi.mock('fs');

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
