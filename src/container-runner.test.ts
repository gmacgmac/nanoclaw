import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('memory directory bootstrap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('pre-creates the Claude Code memory directory before spawning the container', async () => {
    const { default: fs } = await import('fs');
    const mkdirSyncMock = vi.mocked(fs.mkdirSync);

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    // Resolve the container immediately
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Verify mkdirSync was called with the sessions .claude path (not auto-memory)
    const sessionsPathCall = mkdirSyncMock.mock.calls.find(
      ([p]) =>
        typeof p === 'string' &&
        p.includes('sessions') &&
        p.includes('.claude'),
    );
    expect(sessionsPathCall).toBeDefined();
    expect(sessionsPathCall![1]).toEqual({ recursive: true });
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('NANOCLAW_ENDPOINT env var', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('passes NANOCLAW_ENDPOINT=anthropic by default', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const endpointIdx = args.findIndex(
      (a) => a === 'NANOCLAW_ENDPOINT=anthropic',
    );
    // The env var is passed as the value after a '-e' flag
    expect(endpointIdx).toBeGreaterThan(0);
    expect(args[endpointIdx - 1]).toBe('-e');
  });

  it('passes configured endpoint from containerConfig', async () => {
    const groupWithEndpoint: RegisteredGroup = {
      ...testGroup,
      containerConfig: { endpoint: 'ollama' },
    };

    const resultPromise = runContainerAgent(
      groupWithEndpoint,
      testInput,
      () => {},
      undefined,
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const endpointIdx = args.findIndex((a) => a === 'NANOCLAW_ENDPOINT=ollama');
    expect(endpointIdx).toBeGreaterThan(0);
    expect(args[endpointIdx - 1]).toBe('-e');
  });
});

describe('NANOCLAW_WEB_SEARCH env vars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('injects web search env vars when nanoclaw-web-search MCP is configured', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        webSearchVendor: 'ollama',
        mcpServers: {
          'nanoclaw-web-search': {
            command: 'node',
            args: ['/app/mcp-servers/nanoclaw-web-search/dist/index.js'],
          },
        },
      },
    };

    const resultPromise = runContainerAgent(
      group,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];

    // NANOCLAW_WEB_SEARCH_VENDOR
    const vendorIdx = args.findIndex(
      (a) => a === 'NANOCLAW_WEB_SEARCH_VENDOR=ollama',
    );
    expect(vendorIdx).toBeGreaterThan(0);
    expect(args[vendorIdx - 1]).toBe('-e');

    // NANOCLAW_PROXY_HOST
    const hostIdx = args.findIndex((a) => a.startsWith('NANOCLAW_PROXY_HOST='));
    expect(hostIdx).toBeGreaterThan(0);
    expect(args[hostIdx - 1]).toBe('-e');

    // NANOCLAW_PROXY_PORT
    const portIdx = args.findIndex((a) => a.startsWith('NANOCLAW_PROXY_PORT='));
    expect(portIdx).toBeGreaterThan(0);
    expect(args[portIdx - 1]).toBe('-e');
  });

  it('defaults webSearchVendor to ollama when not specified', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        mcpServers: {
          'nanoclaw-web-search': {
            command: 'node',
            args: ['/app/mcp-servers/nanoclaw-web-search/dist/index.js'],
          },
        },
      },
    };

    const resultPromise = runContainerAgent(
      group,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const vendorIdx = args.findIndex(
      (a) => a === 'NANOCLAW_WEB_SEARCH_VENDOR=ollama',
    );
    expect(vendorIdx).toBeGreaterThan(0);
  });

  it('uses custom webSearchVendor when configured', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        webSearchVendor: 'zai',
        mcpServers: {
          'nanoclaw-web-search': {
            command: 'node',
            args: ['/app/mcp-servers/nanoclaw-web-search/dist/index.js'],
          },
        },
      },
    };

    const resultPromise = runContainerAgent(
      group,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const vendorIdx = args.findIndex(
      (a) => a === 'NANOCLAW_WEB_SEARCH_VENDOR=zai',
    );
    expect(vendorIdx).toBeGreaterThan(0);
  });

  it('does NOT inject web search env vars when nanoclaw-web-search MCP is absent', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        mcpServers: {
          'brave-search': { command: 'node', args: ['server.js'] },
        },
      },
    };

    const resultPromise = runContainerAgent(
      group,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const vendorIdx = args.findIndex((a) =>
      a.startsWith('NANOCLAW_WEB_SEARCH_VENDOR='),
    );
    expect(vendorIdx).toBe(-1);
  });

  it('does NOT inject web search env vars when containerConfig is absent', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const vendorIdx = args.findIndex((a) =>
      a.startsWith('NANOCLAW_WEB_SEARCH_VENDOR='),
    );
    expect(vendorIdx).toBe(-1);
  });

  it('web search env vars coexist with brave-search and endpoint', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        endpoint: 'ollama',
        webSearchVendor: 'ollama',
        mcpServers: {
          'brave-search': { command: 'node', args: ['server.js'] },
          'nanoclaw-web-search': {
            command: 'node',
            args: ['/app/mcp-servers/nanoclaw-web-search/dist/index.js'],
          },
        },
      },
    };

    const resultPromise = runContainerAgent(
      group,
      testInput,
      () => {},
      undefined,
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];

    // All three should be present
    expect(
      args.findIndex((a) => a === 'NANOCLAW_ENDPOINT=ollama'),
    ).toBeGreaterThan(0);
    expect(
      args.findIndex((a) => a === 'NANOCLAW_WEB_SEARCH_VENDOR=ollama'),
    ).toBeGreaterThan(0);
    expect(
      args.findIndex((a) => a.startsWith('NANOCLAW_PROXY_HOST=')),
    ).toBeGreaterThan(0);
    expect(
      args.findIndex((a) => a.startsWith('NANOCLAW_PROXY_PORT=')),
    ).toBeGreaterThan(0);
  });
});

describe('NANOCLAW_APPROVAL_MODE env vars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('passes NANOCLAW_APPROVAL_MODE=true when approvalMode is enabled', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: { approvalMode: true },
    };

    const resultPromise = runContainerAgent(group, testInput, () => {}, undefined);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const modeIdx = args.findIndex((a) => a === 'NANOCLAW_APPROVAL_MODE=true');
    expect(modeIdx).toBeGreaterThan(0);
    expect(args[modeIdx - 1]).toBe('-e');
  });

  it('passes NANOCLAW_WRITE_MOUNTS as JSON array when approvalMode is enabled', async () => {
    // validateAdditionalMounts is mocked to return empty by default.
    // We need to override it for this test to return write mounts.
    const { validateAdditionalMounts } = await import('./mount-security.js');
    vi.mocked(validateAdditionalMounts).mockReturnValueOnce([
      { hostPath: '/home/user/finance', containerPath: '/workspace/extra/finance', readonly: false },
      { hostPath: '/home/user/docs', containerPath: '/workspace/extra/docs', readonly: true },
    ]);

    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        approvalMode: true,
        additionalMounts: [
          { hostPath: '~/finance', readonly: false },
          { hostPath: '~/docs', readonly: true },
        ],
      },
    };

    const resultPromise = runContainerAgent(group, testInput, () => {}, undefined);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const mountsArg = args.find((a) => a.startsWith('NANOCLAW_WRITE_MOUNTS='));
    expect(mountsArg).toBeDefined();
    const parsed = JSON.parse(mountsArg!.replace('NANOCLAW_WRITE_MOUNTS=', ''));
    // Only the non-readonly mount under /workspace/extra/ should be included
    expect(parsed).toEqual(['/workspace/extra/finance']);
  });

  it('does NOT pass approval env vars when approvalMode is false', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: { approvalMode: false },
    };

    const resultPromise = runContainerAgent(group, testInput, () => {}, undefined);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.findIndex((a) => a.startsWith('NANOCLAW_APPROVAL_MODE='))).toBe(-1);
    expect(args.findIndex((a) => a.startsWith('NANOCLAW_WRITE_MOUNTS='))).toBe(-1);
  });

  it('does NOT pass approval env vars when approvalMode is absent', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, undefined);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.findIndex((a) => a.startsWith('NANOCLAW_APPROVAL_MODE='))).toBe(-1);
    expect(args.findIndex((a) => a.startsWith('NANOCLAW_WRITE_MOUNTS='))).toBe(-1);
  });

  it('passes empty NANOCLAW_WRITE_MOUNTS when no write mounts exist', async () => {
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: { approvalMode: true },
    };

    const resultPromise = runContainerAgent(group, testInput, () => {}, undefined);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    const args = spawnMock.mock.calls[0][1] as string[];
    const mountsArg = args.find((a) => a.startsWith('NANOCLAW_WRITE_MOUNTS='));
    expect(mountsArg).toBeDefined();
    const parsed = JSON.parse(mountsArg!.replace('NANOCLAW_WRITE_MOUNTS=', ''));
    expect(parsed).toEqual([]);
  });
});
