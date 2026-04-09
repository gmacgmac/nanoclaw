/**
 * Targeted test: When flushCompleted: true arrives via the streaming callback,
 * the host must do all 3 things:
 *
 * 1. closeStdin (write _close sentinel → container shuts down)
 * 2. delete sessions[group.folder] (in-memory cache)
 * 3. deleteSession(group.folder) (SQLite)
 *
 * We replicate the wrappedOnOutput logic from index.ts and verify the
 * exact behavior with mocked dependencies.
 *
 * Tests:
 * 1. flushCompleted: true triggers all 3 cleanup actions
 * 2. Order: closeStdin → memory clear → DB clear
 * 3. flushCompleted: undefined does NOT trigger cleanup
 * 4. newSessionId is set BEFORE flushCompleted clears it (flush wins)
 * 5. Normal result with no flushCompleted — no cleanup
 * 6. Integration: full container-runner → wrappedOnOutput pipeline
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// --- Types (mirror from container-runner.ts) ---
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  flushCompleted?: boolean;
}

// --- Mocks ---
const callOrder: string[] = [];

const mockCloseStdin = vi.fn((chatJid: string) => {
  callOrder.push(`closeStdin:${chatJid}`);
});

const mockDeleteSession = vi.fn((groupFolder: string) => {
  callOrder.push(`deleteSession:${groupFolder}`);
});

const mockSetSession = vi.fn();

/**
 * Replicate the exact wrappedOnOutput logic from index.ts runAgent().
 * This is a direct copy — if the source changes, this test should be updated.
 */
function createWrappedOnOutput(
  group: { name: string; folder: string },
  chatJid: string,
  sessions: Record<string, string>,
  onOutput: (output: ContainerOutput) => Promise<void>,
) {
  return async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      mockSetSession(group.folder, output.newSessionId);
    }
    if (output.flushCompleted) {
      mockCloseStdin(chatJid);
      delete sessions[group.folder];
      mockDeleteSession(group.folder);
    }
    await onOutput(output);
  };
}

describe('wrappedOnOutput flush cleanup', () => {
  let sessions: Record<string, string>;
  const group = { name: 'Test Group', folder: 'test-group' };
  const chatJid = 'test@g.us';

  beforeEach(() => {
    sessions = {};
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it('flushCompleted: true triggers all 3 cleanup actions', async () => {
    const onOutput = vi.fn(async () => {});
    const wrapped = createWrappedOnOutput(group, chatJid, sessions, onOutput);

    await wrapped({
      status: 'success',
      result: null,
      newSessionId: 'sess-1',
      flushCompleted: true,
    });

    expect(mockCloseStdin).toHaveBeenCalledWith(chatJid);
    expect(mockDeleteSession).toHaveBeenCalledWith(group.folder);
    expect(sessions[group.folder]).toBeUndefined();
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('order: closeStdin → memory clear → deleteSession', async () => {
    const onOutput = vi.fn(async () => {});
    const wrapped = createWrappedOnOutput(group, chatJid, sessions, onOutput);

    await wrapped({
      status: 'success',
      result: null,
      newSessionId: 'sess-2',
      flushCompleted: true,
    });

    // closeStdin must come first, then deleteSession
    expect(callOrder).toEqual([
      `closeStdin:${chatJid}`,
      `deleteSession:${group.folder}`,
    ]);

    // Memory clear happens between them (verified by sessions being empty)
    // newSessionId was set first, then flush cleared it
    expect(sessions[group.folder]).toBeUndefined();
  });

  it('flushCompleted: undefined does NOT trigger cleanup', async () => {
    const onOutput = vi.fn(async () => {});
    const wrapped = createWrappedOnOutput(group, chatJid, sessions, onOutput);

    await wrapped({
      status: 'success',
      result: null,
      newSessionId: 'sess-3',
    });

    expect(mockCloseStdin).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(sessions[group.folder]).toBe('sess-3');
  });

  it('newSessionId is set BEFORE flushCompleted clears it', async () => {
    const onOutput = vi.fn(async () => {});
    const wrapped = createWrappedOnOutput(group, chatJid, sessions, onOutput);

    // Verify setSession was called (session was set) before delete cleared it
    mockSetSession.mockImplementation((folder: string, id: string) => {
      callOrder.push(`setSession:${folder}:${id}`);
    });

    await wrapped({
      status: 'success',
      result: null,
      newSessionId: 'sess-4',
      flushCompleted: true,
    });

    expect(callOrder).toEqual([
      'setSession:test-group:sess-4',
      `closeStdin:${chatJid}`,
      `deleteSession:${group.folder}`,
    ]);

    // Final state: session is cleared (flush wins)
    expect(sessions[group.folder]).toBeUndefined();
  });

  it('normal result with no flushCompleted — no cleanup', async () => {
    sessions[group.folder] = 'existing-session';
    const onOutput = vi.fn(async () => {});
    const wrapped = createWrappedOnOutput(group, chatJid, sessions, onOutput);

    await wrapped({
      status: 'success',
      result: 'Hello there',
      newSessionId: 'sess-5',
    });

    expect(mockCloseStdin).not.toHaveBeenCalled();
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(sessions[group.folder]).toBe('sess-5');
  });
});

// --- Integration test: full container-runner → wrappedOnOutput pipeline ---

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

import { runContainerAgent } from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

function emitMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`);
}

describe('integration: container-runner → wrappedOnOutput → flush cleanup', () => {
  const group = { name: 'Test Group', folder: 'test-group' };
  const chatJid = 'test@g.us';

  const testGroupFull: RegisteredGroup = {
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

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('full pipeline: flushCompleted marker → closeStdin + memory + DB cleanup', async () => {
    const sessions: Record<string, string> = {};
    const outerOnOutput = vi.fn(async () => {});

    // Build wrappedOnOutput exactly as runAgent does
    const wrappedOnOutput = createWrappedOnOutput(group, chatJid, sessions, outerOnOutput);

    const resultPromise = runContainerAgent(
      testGroupFull,
      testInput,
      () => {},
      wrappedOnOutput,
    );

    // Agent sends a normal response first
    emitMarker(fakeProc, { status: 'success', result: 'Hi there', newSessionId: 'sess-int-1' });
    await vi.advanceTimersByTimeAsync(10);

    // Then flush completes
    emitMarker(fakeProc, { status: 'success', result: null, newSessionId: 'sess-int-1', flushCompleted: true });
    await vi.advanceTimersByTimeAsync(10);

    // Container exits (no more session-update marker after flush — agent-runner skips it)
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    // wrappedOnOutput was called 2 times (response + flush marker)
    expect(outerOnOutput).toHaveBeenCalledTimes(2);

    // Flush cleanup happened
    expect(mockCloseStdin).toHaveBeenCalledWith(chatJid);
    expect(mockDeleteSession).toHaveBeenCalledWith(group.folder);

    // Session was cleared and stays cleared (no trailing session-update to undo it)
    expect(sessions[group.folder]).toBeUndefined();
  });
});
