import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock db.js
vi.mock('./db.js', () => ({
  setRegisteredGroup: vi.fn(),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getRouterState: vi.fn(() => ''),
  initDatabase: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  log: vi.fn(),
}));

// Mock router
vi.mock('./router.js', () => ({
  findChannel: vi.fn(),
  formatMessages: vi.fn(),
  formatOutbound: vi.fn(),
  routeOutbound: vi.fn(),
  escapeXml: vi.fn(),
}));

import { findChannel } from './router.js';
import { setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import {
  updateRegisteredGroup,
  setChannelList,
  setRegisteredGroups,
  getRegisteredGroup,
} from './group-registry.js';
import type { Channel, RegisteredGroup } from './types.js';

describe('updateRegisteredGroup', () => {
  const mockGroup: RegisteredGroup = {
    name: 'Test',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
    containerConfig: { allowedHostCommands: ['model'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setRegisteredGroups({});
    setChannelList([]);
  });

  it('dispatches onGroupUpdated only to the channel that owns the JID', async () => {
    const telegramHook = vi.fn().mockResolvedValue(undefined);
    const telegramChannel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
      onGroupUpdated: telegramHook,
    };

    const whatsappChannel: Channel = {
      name: 'whatsapp',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: (jid: string) => jid.startsWith('wa:'),
      disconnect: vi.fn(),
      onGroupUpdated: vi.fn(),
    };

    const channels = [telegramChannel, whatsappChannel];
    setChannelList(channels);

    (findChannel as ReturnType<typeof vi.fn>).mockImplementation(
      (chs: Channel[], jid: string) => chs.find((c) => c.ownsJid(jid)),
    );

    await updateRegisteredGroup('tg:100200300', mockGroup);

    expect(setRegisteredGroup).toHaveBeenCalledWith('tg:100200300', mockGroup);
    expect(getRegisteredGroup('tg:100200300')).toBe(mockGroup);
    expect(telegramHook).toHaveBeenCalledWith('tg:100200300');
    expect(whatsappChannel.onGroupUpdated).not.toHaveBeenCalled();
  });

  it('swallows errors from onGroupUpdated without propagating', async () => {
    const hookError = new Error('Telegram API down');
    const failingChannel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: () => true,
      disconnect: vi.fn(),
      onGroupUpdated: vi.fn().mockRejectedValue(hookError),
    };

    setChannelList([failingChannel]);

    (findChannel as ReturnType<typeof vi.fn>).mockImplementation(
      (chs: Channel[], jid: string) => chs.find((c) => c.ownsJid(jid)),
    );

    // Should not throw
    await expect(
      updateRegisteredGroup('tg:100200300', mockGroup),
    ).resolves.toBeUndefined();

    // DB write still happened
    expect(setRegisteredGroup).toHaveBeenCalledWith('tg:100200300', mockGroup);
    expect(getRegisteredGroup('tg:100200300')).toBe(mockGroup);

    // Error was logged
    expect(logger.warn).toHaveBeenCalledWith(
      { jid: 'tg:100200300', channel: 'telegram', err: hookError },
      'onGroupUpdated hook failed',
    );
  });

  it('does nothing when no channel owns the JID', async () => {
    const channel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: () => false,
      disconnect: vi.fn(),
      onGroupUpdated: vi.fn(),
    };

    setChannelList([channel]);

    (findChannel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await updateRegisteredGroup('unknown:123', mockGroup);

    expect(setRegisteredGroup).toHaveBeenCalledWith('unknown:123', mockGroup);
    expect(getRegisteredGroup('unknown:123')).toBe(mockGroup);
    expect(channel.onGroupUpdated).not.toHaveBeenCalled();
  });
});
