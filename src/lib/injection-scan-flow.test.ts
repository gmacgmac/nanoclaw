/**
 * BE_02: Unit tests for injection-scan-flow.ts
 *
 * Tests runInjectionScan() — all 9 branches:
 * off, warn-clean, warn-findings, warn-alert, warn-no-channel,
 * block-critical, block-warning-only, alert-throws, block-notification-fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./context-scanner.js', () => ({
  scanContextFiles: vi.fn(),
}));

vi.mock('../router.js', () => ({
  findChannel: vi.fn(),
  routeOutbound: vi.fn(),
}));

vi.mock('../group-registry.js', () => ({
  getChannelList: vi.fn(() => []),
}));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/fake/groups/test-group'),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/fake/groups',
}));

import { scanContextFiles } from './context-scanner.js';
import { findChannel, routeOutbound } from '../router.js';
import { getChannelList } from '../group-registry.js';
import { logger, log } from '../logger.js';
import { runInjectionScan, InjectionScanArgs } from './injection-scan-flow.js';
import type { RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockScanContextFiles = scanContextFiles as ReturnType<typeof vi.fn>;
const mockFindChannel = findChannel as ReturnType<typeof vi.fn>;
const mockRouteOutbound = routeOutbound as ReturnType<typeof vi.fn>;
const mockGetChannelList = getChannelList as ReturnType<typeof vi.fn>;

function makeGroup(overrides?: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    name: 'TestGroup',
    folder: 'test-group',
    trigger: '@Bot',
    added_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeArgs(overrides?: Partial<InjectionScanArgs>): InjectionScanArgs {
  return {
    group: makeGroup(),
    chatJid: 'wa:123456',
    scanMode: 'warn',
    isMain: false,
    ...overrides,
  };
}

function makeFinding(overrides?: Record<string, unknown>) {
  return {
    file: 'CLAUDE.md',
    severity: 'critical',
    pattern: 'instruction-override',
    description: 'Instruction override detected',
    line: 1,
    ...overrides,
  };
}

const ENV_BACKUP = { ...process.env };

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NANOCLAW_ALERT_JID;
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInjectionScan', () => {
  // -------------------------------------------------------------------------
  // 1. scanMode = 'off'
  // -------------------------------------------------------------------------
  it('returns proceed:true and skips scan when scanMode is off', async () => {
    const result = await runInjectionScan(makeArgs({ scanMode: 'off' }));

    expect(result).toEqual({ proceed: true });
    expect(mockScanContextFiles).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. scanMode = 'warn', clean scan
  // -------------------------------------------------------------------------
  it('returns proceed:true with no warnings when scan is clean', async () => {
    mockScanContextFiles.mockReturnValue({
      clean: true,
      hasCritical: false,
      findings: [],
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    const result = await runInjectionScan(makeArgs({ scanMode: 'warn' }));

    expect(result).toEqual({ proceed: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. scanMode = 'warn', findings present
  // -------------------------------------------------------------------------
  it('logs each finding and returns proceed:true in warn mode', async () => {
    const findings = [
      makeFinding({ file: 'CLAUDE.md', line: 2 }),
      makeFinding({ file: 'memory/MEMORY.md', severity: 'warning', line: 5 }),
    ];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: true,
      findings,
      scannedFiles: ['CLAUDE.md', 'memory/MEMORY.md'],
      skippedFiles: [],
    });

    const result = await runInjectionScan(makeArgs({ scanMode: 'warn' }));

    expect(result).toEqual({ proceed: true });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 4. scanMode = 'warn', alert JID + channel connected
  // -------------------------------------------------------------------------
  it('routes alerts via routeOutbound when alert JID channel is connected', async () => {
    process.env.NANOCLAW_ALERT_JID = 'wa:alert-channel';

    const findings = [makeFinding()];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: true,
      findings,
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    const mockChannel = { isConnected: () => true, sendMessage: vi.fn() };
    const channels = [mockChannel];
    mockGetChannelList.mockReturnValue(channels);
    mockFindChannel.mockReturnValue(mockChannel);
    mockRouteOutbound.mockResolvedValue(undefined);

    const result = await runInjectionScan(makeArgs({ scanMode: 'warn' }));

    expect(result).toEqual({ proceed: true });
    expect(mockRouteOutbound).toHaveBeenCalledTimes(1);
    expect(mockRouteOutbound).toHaveBeenCalledWith(
      channels,
      'wa:alert-channel',
      expect.stringContaining('[INJECTION SCAN]'),
    );
  });

  // -------------------------------------------------------------------------
  // 5. scanMode = 'warn', alert JID + channel NOT connected
  // -------------------------------------------------------------------------
  it('logs warning when alert JID channel is not connected', async () => {
    process.env.NANOCLAW_ALERT_JID = 'wa:alert-channel';

    const findings = [makeFinding()];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: false,
      findings,
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    mockGetChannelList.mockReturnValue([]);
    mockFindChannel.mockReturnValue(undefined);

    const result = await runInjectionScan(makeArgs({ scanMode: 'warn' }));

    expect(result).toEqual({ proceed: true });
    // logger.warn called for finding + for missing channel
    expect(logger.warn).toHaveBeenCalledWith(
      { jid: 'wa:alert-channel' },
      expect.stringContaining('no channel owns this JID'),
    );
  });

  // -------------------------------------------------------------------------
  // 6. scanMode = 'block', critical findings
  // -------------------------------------------------------------------------
  it('returns proceed:false and logs error when block mode has critical findings', async () => {
    const findings = [
      makeFinding({ severity: 'critical', file: 'CLAUDE.md', line: 1 }),
      makeFinding({ severity: 'warning', file: 'memory/MEMORY.md', line: 3 }),
    ];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: true,
      findings,
      scannedFiles: ['CLAUDE.md', 'memory/MEMORY.md'],
      skippedFiles: [],
    });

    const mockChannel = { isConnected: () => true, sendMessage: vi.fn().mockResolvedValue(undefined) };
    mockGetChannelList.mockReturnValue([mockChannel]);
    mockFindChannel.mockReturnValue(mockChannel);

    const result = await runInjectionScan(makeArgs({ scanMode: 'block' }));

    expect(result).toEqual({ proceed: false });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'TestGroup' }),
      expect.stringContaining('blocked container launch'),
    );
    // Notification sent to group chat
    expect(mockChannel.sendMessage).toHaveBeenCalledWith(
      'wa:123456',
      expect.stringContaining('Blocked'),
    );
  });

  // -------------------------------------------------------------------------
  // 7. scanMode = 'block', warnings only (no critical)
  // -------------------------------------------------------------------------
  it('returns proceed:true in block mode when only warnings exist', async () => {
    const findings = [
      makeFinding({ severity: 'warning', pattern: 'invisible-unicode' }),
    ];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: false,
      findings,
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    const result = await runInjectionScan(makeArgs({ scanMode: 'block' }));

    expect(result).toEqual({ proceed: true });
    expect(log.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. Alert routing throws
  // -------------------------------------------------------------------------
  it('swallows routeOutbound errors and still returns proceed:true', async () => {
    process.env.NANOCLAW_ALERT_JID = 'wa:alert-channel';

    const findings = [makeFinding()];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: false,
      findings,
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    const mockChannel = { isConnected: () => true, sendMessage: vi.fn() };
    mockGetChannelList.mockReturnValue([mockChannel]);
    mockFindChannel.mockReturnValue(mockChannel);
    mockRouteOutbound.mockRejectedValue(new Error('Network error'));

    const result = await runInjectionScan(makeArgs({ scanMode: 'warn' }));

    expect(result).toEqual({ proceed: true });
    // Error was logged, not thrown
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'wa:alert-channel' }),
      'Failed to send injection scan alert',
    );
  });

  // -------------------------------------------------------------------------
  // 9. Block notification fails (channel not connected)
  // -------------------------------------------------------------------------
  it('returns proceed:false even when block notification channel is unavailable', async () => {
    const findings = [
      makeFinding({ severity: 'critical', file: 'CLAUDE.md', line: 1 }),
    ];
    mockScanContextFiles.mockReturnValue({
      clean: false,
      hasCritical: true,
      findings,
      scannedFiles: ['CLAUDE.md'],
      skippedFiles: [],
    });

    // No connected channel for the group chat
    mockGetChannelList.mockReturnValue([]);
    mockFindChannel.mockReturnValue(undefined);

    const result = await runInjectionScan(makeArgs({ scanMode: 'block' }));

    expect(result).toEqual({ proceed: false });
    expect(log.error).toHaveBeenCalled();
  });
});
