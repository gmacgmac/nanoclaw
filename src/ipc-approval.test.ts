import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { processIpcMessageData, checkApprovalResponse, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
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

// Mock db (required by ipc.ts imports)
vi.mock('./db.js', () => ({
  createDelegation: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  fulfillDelegation: vi.fn(),
  getDelegationByUuid: vi.fn(),
  getTaskById: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateTask: vi.fn(),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
}));

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  groups = { 'tg:main': MAIN_GROUP };
  sendMessageMock = vi.fn(async () => {});

  deps = {
    sendMessage: sendMessageMock,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    enqueueMessageCheck: vi.fn(),
  };

  vi.restoreAllMocks();
});

// --- processIpcMessageData: approval_request handling ---

describe('processIpcMessageData — approval_request', () => {
  it('sends formatted approval message to user channel', async () => {
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        command: 'rm -rf /workspace/extra/finance/old/',
        patterns: [{ name: 'rm-recursive', description: 'Recursive file deletion', matched: 'rm -rf' }],
        targetPaths: ['/workspace/extra/finance'],
        timestamp: Date.now(),
        ttl: 120,
        groupFolder: 'telegram_main',
      },
      'telegram_main',
      true,
      deps,
    );

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0][1] as string;
    expect(msg).toContain('⚠️ Command requires approval');
    expect(msg).toContain('rm -rf /workspace/extra/finance/old/');
    expect(msg).toContain('Recursive file deletion');
    expect(msg).toContain('/workspace/extra/finance');
    expect(msg).toContain('Reply "yes" to approve');
    expect(msg).toContain('120s');
  });

  it('ignores approval_request with missing chatJid', async () => {
    await processIpcMessageData(
      {
        type: 'approval_request',
        command: 'rm -rf /tmp',
        timestamp: Date.now(),
        ttl: 120,
      },
      'telegram_main',
      true,
      deps,
    );

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('ignores approval_request with missing command', async () => {
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        timestamp: Date.now(),
        ttl: 120,
      },
      'telegram_main',
      true,
      deps,
    );

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('auto-denies when sendMessage fails (no channel)', async () => {
    const failingSend = vi.fn(async () => { throw new Error('No channel'); });
    const failDeps = { ...deps, sendMessage: failingSend };

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        command: 'rm -rf /workspace/extra/data/',
        patterns: [],
        targetPaths: ['/workspace/extra/data'],
        timestamp: Date.now(),
        ttl: 120,
        groupFolder: 'telegram_main',
      },
      'telegram_main',
      true,
      failDeps,
    );

    // Should write auto-deny response
    const writeCall = writeSpy.mock.calls.find(
      ([p]) => typeof p === 'string' && p.includes('_approval_response'),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.approved).toBe(false);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('auto-denies previous pending approval when new request arrives for same JID', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    // First request — stores pending approval
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        command: 'rm -rf /workspace/extra/a/',
        patterns: [{ name: 'rm-recursive', description: 'Recursive delete', matched: 'rm -rf' }],
        targetPaths: ['/workspace/extra/a'],
        timestamp: Date.now(),
        ttl: 120,
      },
      'telegram_main',
      true,
      deps,
    );

    // Clear spy calls from first request
    writeSpy.mockClear();

    // Second request for same JID — should auto-deny the first
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        command: 'rm -rf /workspace/extra/b/',
        patterns: [{ name: 'rm-recursive', description: 'Recursive delete', matched: 'rm -rf' }],
        targetPaths: ['/workspace/extra/b'],
        timestamp: Date.now(),
        ttl: 120,
      },
      'telegram_main',
      true,
      deps,
    );

    // Should have written an auto-deny for the first request
    const denyCalls = writeSpy.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('_approval_response'),
    );
    expect(denyCalls.length).toBe(1);
    const denied = JSON.parse(denyCalls[0][1] as string);
    expect(denied.approved).toBe(false);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('defaults ttl to 120 when not provided', async () => {
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:main',
        command: 'rm -rf /workspace/extra/data/',
        patterns: [],
        targetPaths: [],
        timestamp: Date.now(),
      },
      'telegram_main',
      true,
      deps,
    );

    const msg = sendMessageMock.mock.calls[0][1] as string;
    expect(msg).toContain('120s');
  });
});

// --- checkApprovalResponse ---

describe('checkApprovalResponse', () => {
  const confirmSend = vi.fn(async () => {});

  beforeEach(async () => {
    confirmSend.mockClear();

    // Set up a pending approval by sending an approval_request through IPC
    await processIpcMessageData(
      {
        type: 'approval_request',
        chatJid: 'tg:user123',
        command: 'rm -rf /workspace/extra/finance/',
        patterns: [{ name: 'rm-recursive', description: 'Recursive delete', matched: 'rm -rf' }],
        targetPaths: ['/workspace/extra/finance'],
        timestamp: Date.now(),
        ttl: 300,
      },
      'test_group',
      false,
      deps,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when no pending approval for JID', () => {
    const result = checkApprovalResponse('tg:unknown', 'yes', confirmSend);
    expect(result).toBe(false);
  });

  it('returns false for non-approval text', () => {
    const result = checkApprovalResponse('tg:user123', 'hello world', confirmSend);
    expect(result).toBe(false);
  });

  it('approves on "yes" and writes response file', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = checkApprovalResponse('tg:user123', 'yes', confirmSend);

    expect(result).toBe(true);

    const writeCall = writeSpy.mock.calls.find(
      ([p]) => typeof p === 'string' && p.includes('_approval_response'),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.type).toBe('approval_response');
    expect(written.approved).toBe(true);

    // Confirmation message sent
    expect(confirmSend).toHaveBeenCalledWith('tg:user123', '✅ Command approved');

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('denies on "no" and writes response file', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = checkApprovalResponse('tg:user123', 'no', confirmSend);

    expect(result).toBe(true);

    const writeCall = writeSpy.mock.calls.find(
      ([p]) => typeof p === 'string' && p.includes('_approval_response'),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.approved).toBe(false);

    expect(confirmSend).toHaveBeenCalledWith('tg:user123', '❌ Command denied');

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('accepts case-insensitive variants: YES, Yes, y, Y', async () => {
    // We need to re-create pending approvals for each variant since they get consumed
    const variants = ['YES', 'Yes', 'y', 'Y', 'approve', 'APPROVE'];

    for (const variant of variants) {
      // Re-create pending approval
      await processIpcMessageData(
        {
          type: 'approval_request',
          chatJid: 'tg:variant',
          command: 'rm -rf /workspace/extra/data/',
          patterns: [],
          targetPaths: ['/workspace/extra/data'],
          timestamp: Date.now(),
          ttl: 300,
        },
        'test_group',
        false,
        deps,
      );

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = checkApprovalResponse('tg:variant', variant, confirmSend);
      expect(result).toBe(true);

      const writeCall = writeSpy.mock.calls.find(
        ([p]) => typeof p === 'string' && p.includes('_approval_response'),
      );
      const written = JSON.parse(writeCall![1] as string);
      expect(written.approved).toBe(true);

      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('accepts deny variants: NO, No, n, N, deny, DENY', async () => {
    const variants = ['NO', 'No', 'n', 'N', 'deny', 'DENY'];

    for (const variant of variants) {
      await processIpcMessageData(
        {
          type: 'approval_request',
          chatJid: 'tg:deny-variant',
          command: 'rm -rf /workspace/extra/data/',
          patterns: [],
          targetPaths: ['/workspace/extra/data'],
          timestamp: Date.now(),
          ttl: 300,
        },
        'test_group',
        false,
        deps,
      );

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = checkApprovalResponse('tg:deny-variant', variant, confirmSend);
      expect(result).toBe(true);

      const writeCall = writeSpy.mock.calls.find(
        ([p]) => typeof p === 'string' && p.includes('_approval_response'),
      );
      const written = JSON.parse(writeCall![1] as string);
      expect(written.approved).toBe(false);

      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('handles whitespace-padded responses', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = checkApprovalResponse('tg:user123', '  yes  ', confirmSend);
    expect(result).toBe(true);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('clears pending approval after response', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    checkApprovalResponse('tg:user123', 'yes', confirmSend);

    // Second call should return false (no pending approval)
    const result = checkApprovalResponse('tg:user123', 'yes', confirmSend);
    expect(result).toBe(false);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('writes response to correct IPC input directory', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    checkApprovalResponse('tg:user123', 'yes', confirmSend);

    const writeCall = writeSpy.mock.calls.find(
      ([p]) => typeof p === 'string' && p.includes('_approval_response'),
    );
    const writtenPath = writeCall![0] as string;
    // Should be in the source group's IPC input directory
    expect(writtenPath).toContain('test_group');
    expect(writtenPath).toContain('input');
    expect(writtenPath).toContain('_approval_response');

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });
});
