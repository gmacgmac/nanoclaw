/**
 * Targeted test: Does the host-side streaming parser actually deliver
 * flushCompleted: true to the onOutput callback?
 *
 * This isolates the container-runner's stdout parsing from the rest of
 * the system. We emit markers on a fake process stdout and verify:
 *
 * 1. onOutput IS called for a marker with flushCompleted: true
 * 2. onOutput receives the flushCompleted field intact (not stripped)
 * 3. The final resolved ContainerOutput does NOT carry flushCompleted
 *    (confirming the post-output block in index.ts can't rely on it)
 * 4. onOutput is called for result: null markers (not filtered out)
 * 5. Multiple markers in sequence: session-update then flush — both arrive
 * 6. Chunked delivery: marker split across two stdout chunks
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

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

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

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

function emitMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('flushCompleted host-side detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('onOutput IS called for a marker with flushCompleted: true', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    emitMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'sess-1',
      flushCompleted: true,
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ flushCompleted: true }),
    );
  });

  it('onOutput receives flushCompleted field intact — not stripped by JSON parse', async () => {
    const received: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      received.push(output);
    });
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    emitMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'sess-2',
      flushCompleted: true,
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(received).toHaveLength(1);
    expect(received[0].flushCompleted).toBe(true);
    expect(received[0].result).toBeNull();
    expect(received[0].newSessionId).toBe('sess-2');
  });

  it('final resolved ContainerOutput does NOT carry flushCompleted (streaming mode)', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    emitMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'sess-3',
      flushCompleted: true,
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const finalOutput = await resultPromise;

    // The streaming-mode resolve constructs a new object without flushCompleted
    expect(finalOutput.flushCompleted).toBeUndefined();
    expect(finalOutput.newSessionId).toBe('sess-3');
    expect(finalOutput.status).toBe('success');
  });

  it('onOutput IS called for result: null markers (not filtered)', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // Session-update marker (result: null, no flushCompleted)
    emitMarker(fakeProc, { status: 'success', result: null, newSessionId: 'sess-4' });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: null, newSessionId: 'sess-4' }),
    );
  });

  it('multiple markers: session-update then flush — both delivered to onOutput', async () => {
    const received: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      received.push(output);
    });
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    // First: normal agent response
    emitMarker(fakeProc, { status: 'success', result: 'Hello there', newSessionId: 'sess-5' });
    await vi.advanceTimersByTimeAsync(10);

    // Second: flush completed marker
    emitMarker(fakeProc, { status: 'success', result: null, newSessionId: 'sess-5', flushCompleted: true });
    await vi.advanceTimersByTimeAsync(10);

    // Third: session-update (emitted unconditionally after flush in agent-runner)
    emitMarker(fakeProc, { status: 'success', result: null, newSessionId: 'sess-5' });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(received).toHaveLength(3);
    expect(received[0].result).toBe('Hello there');
    expect(received[0].flushCompleted).toBeUndefined();
    expect(received[1].flushCompleted).toBe(true);
    expect(received[2].flushCompleted).toBeUndefined();
  });

  it('chunked delivery: marker split across two stdout chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    const json = JSON.stringify({
      status: 'success',
      result: null,
      newSessionId: 'sess-6',
      flushCompleted: true,
    });
    const fullMarker = `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`;

    // Split in the middle of the JSON
    const splitPoint = Math.floor(fullMarker.length / 2);
    fakeProc.stdout.push(fullMarker.slice(0, splitPoint));
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.stdout.push(fullMarker.slice(splitPoint));
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ flushCompleted: true }),
    );
  });
});
