import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { NewMessage, RegisteredGroup } from './types.js';

// --- Mocks ---

const mockGroups: Record<string, RegisteredGroup> = {};

vi.mock('./group-registry.js', () => ({
  getRegisteredGroups: () => mockGroups,
}));

const mockStoreMessageDirect = vi.fn();
vi.mock('./db.js', () => ({
  storeMessageDirect: (...args: unknown[]) => mockStoreMessageDirect(...args),
}));

const mockLoggerInfo = vi.fn();
vi.mock('./logger.js', () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args) },
}));

// --- Import after mocks ---

import {
  findDelegationTarget,
  isHubMessage,
  delegateMessage,
  getUnknownMentionNotice,
} from './multi-agent-router.js';

// --- Test fixtures ---

const HUB_JID = 'hub@g.us';

const SUB_AGENT_A: RegisteredGroup = {
  name: 'AgentA',
  folder: 'agent-a',
  trigger: '@AgentA',
  added_at: '2024-01-01T00:00:00.000Z',
};

const SUB_AGENT_B: RegisteredGroup = {
  name: 'AgentB',
  folder: 'agent-b',
  trigger: '@AgentB',
  added_at: '2024-01-01T00:00:00.000Z',
};

const HUB_GROUP: RegisteredGroup = {
  name: 'Hub',
  folder: 'hub',
  trigger: '@Hub',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
  multiAgentRouter: true,
};

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: HUB_JID,
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    is_from_me: false,
    ...overrides,
  };
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();

  // Clear and repopulate mock groups
  for (const key of Object.keys(mockGroups)) delete mockGroups[key];
  mockGroups[HUB_JID] = HUB_GROUP;
  mockGroups['agent-a@g.us'] = SUB_AGENT_A;
  mockGroups['agent-b@g.us'] = SUB_AGENT_B;
});

// --- findDelegationTarget ---

describe('findDelegationTarget', () => {
  it('1: returns target when content matches a sub-agent trigger', () => {
    const msg = makeMsg({ content: '@AgentA do something' });
    const result = findDelegationTarget(msg, HUB_JID);
    expect(result).not.toBeNull();
    expect(result!.targetJid).toBe('agent-a@g.us');
    expect(result!.targetGroup).toBe(SUB_AGENT_A);
  });

  it('2: returns null when content matches no trigger', () => {
    const msg = makeMsg({ content: 'just a normal message' });
    expect(findDelegationTarget(msg, HUB_JID)).toBeNull();
  });

  it('3: returns null when message matches hub own trigger (self-skip)', () => {
    const msg = makeMsg({ content: '@Hub do something' });
    expect(findDelegationTarget(msg, HUB_JID)).toBeNull();
  });

  it('4: returns null when msg.is_from_me is true', () => {
    const msg = makeMsg({ content: '@AgentA do something', is_from_me: true });
    expect(findDelegationTarget(msg, HUB_JID)).toBeNull();
  });

  it('5: first match wins when multiple groups registered', () => {
    // Both agents registered; AgentA comes first in iteration order
    const msg = makeMsg({ content: '@AgentA please help' });
    const result = findDelegationTarget(msg, HUB_JID);
    expect(result!.targetJid).toBe('agent-a@g.us');
  });

  it('6: trigger with special regex chars matches literally', () => {
    const specialGroup: RegisteredGroup = {
      name: 'CLAW',
      folder: 'claw',
      trigger: '@C.L.A.W',
      added_at: '2024-01-01T00:00:00.000Z',
    };
    mockGroups['claw@g.us'] = specialGroup;

    // Should match literal dots
    const msg = makeMsg({ content: '@C.L.A.W analyze this' });
    const result = findDelegationTarget(msg, HUB_JID);
    expect(result).not.toBeNull();
    expect(result!.targetJid).toBe('claw@g.us');

    // Should NOT match with different chars in place of dots
    const msgNoMatch = makeMsg({ content: '@CXLXAXW analyze this' });
    expect(findDelegationTarget(msgNoMatch, HUB_JID)).toBeNull();
  });
});

// --- isHubMessage ---

describe('isHubMessage', () => {
  it('7: returns true when message matches no trigger', () => {
    const msg = makeMsg({ content: 'normal message' });
    expect(isHubMessage(msg, HUB_JID)).toBe(true);
  });

  it('8: returns false when message matches a sub-agent trigger', () => {
    const msg = makeMsg({ content: '@AgentA do something' });
    expect(isHubMessage(msg, HUB_JID)).toBe(false);
  });

  it('9: returns true when msg.is_from_me is true', () => {
    const msg = makeMsg({ content: '@AgentA do something', is_from_me: true });
    expect(isHubMessage(msg, HUB_JID)).toBe(true);
  });
});

// --- delegateMessage ---

describe('delegateMessage', () => {
  const enqueueMessageCheck = vi.fn();

  it('10: calls storeMessageDirect with correct shape and enqueues check', async () => {
    const msg = makeMsg({ content: '@AgentA do something' });
    const target = { targetJid: 'agent-a@g.us', targetGroup: SUB_AGENT_A };

    await delegateMessage({
      hubGroup: HUB_GROUP,
      hubJid: HUB_JID,
      msg,
      target,
      enqueueMessageCheck,
    });

    expect(mockStoreMessageDirect).toHaveBeenCalledTimes(1);
    const stored = mockStoreMessageDirect.mock.calls[0][0];
    expect(stored.chat_jid).toBe('agent-a@g.us');
    expect(stored.sender).toBe(msg.sender);
    expect(stored.sender_name).toBe(msg.sender_name);
    expect(stored.is_from_me).toBe(false);
    expect(stored.is_bot_message).toBe(false);
    expect(stored.content).toContain('do something');
    expect(stored.content).toContain(`[Routed from Hub`);
    expect(stored.content).toContain(HUB_JID);

    expect(enqueueMessageCheck).toHaveBeenCalledWith('agent-a@g.us');
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('11: trigger prefix is stripped from content', async () => {
    const msg = makeMsg({ content: '@AgentA analyze the logs' });
    const target = { targetJid: 'agent-a@g.us', targetGroup: SUB_AGENT_A };

    await delegateMessage({
      hubGroup: HUB_GROUP,
      hubJid: HUB_JID,
      msg,
      target,
      enqueueMessageCheck,
    });

    const stored = mockStoreMessageDirect.mock.calls[0][0];
    // Content should start with the stripped prompt, not the trigger
    expect(stored.content).toMatch(/^analyze the logs/);
  });

  it('12: falls back to msg.content.trim() when content is empty after stripping', async () => {
    const msg = makeMsg({ content: '@AgentA' });
    const target = { targetJid: 'agent-a@g.us', targetGroup: SUB_AGENT_A };

    await delegateMessage({
      hubGroup: HUB_GROUP,
      hubJid: HUB_JID,
      msg,
      target,
      enqueueMessageCheck,
    });

    const stored = mockStoreMessageDirect.mock.calls[0][0];
    // Should fall back to the full trimmed content
    expect(stored.content).toContain('@AgentA');
  });
});

// --- getUnknownMentionNotice ---

describe('getUnknownMentionNotice', () => {
  it('13: returns notice for unrecognized @mention', () => {
    const msg = makeMsg({ content: '@unknown do something' });
    const result = getUnknownMentionNotice(msg, HUB_JID);
    expect(result).toBe('@unknown is not a registered agent.');
  });

  it('14: returns null when @mention matches a registered group trigger', () => {
    const msg = makeMsg({ content: '@AgentA do something' });
    expect(getUnknownMentionNotice(msg, HUB_JID)).toBeNull();
  });

  it('15: returns null when message does not start with @', () => {
    const msg = makeMsg({ content: 'no mention here' });
    expect(getUnknownMentionNotice(msg, HUB_JID)).toBeNull();
  });

  it('16: returns null when msg.is_from_me is true', () => {
    const msg = makeMsg({ content: '@unknown test', is_from_me: true });
    expect(getUnknownMentionNotice(msg, HUB_JID)).toBeNull();
  });
});
