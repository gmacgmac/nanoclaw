import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  getDelegationByUuid,
  fulfillDelegation,
  setRegisteredGroup,
  storeChatMetadata,
  getMessagesSince,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let enqueueMessageCheck: (jid: string) => void;

beforeEach(() => {
  _initTestDatabase();

  storeChatMetadata(
    'main@g.us',
    new Date().toISOString(),
    'Main',
    'whatsapp',
    true,
  );
  storeChatMetadata(
    'other@g.us',
    new Date().toISOString(),
    'Other',
    'whatsapp',
    true,
  );
  storeChatMetadata(
    'third@g.us',
    new Date().toISOString(),
    'Third',
    'whatsapp',
    true,
  );

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  enqueueMessageCheck = vi.fn();

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    enqueueMessageCheck,
  };
});

// --- DB CRUD for delegations ---

describe('delegation DB CRUD', () => {
  it('creates and retrieves a delegation', () => {
    createDelegation({
      uuid: 'test-uuid-1',
      caller_jid: 'main@g.us',
      target_jid: 'other@g.us',
      created_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2026-04-01T00:05:00.000Z',
      status: 'pending',
    });

    const d = getDelegationByUuid('test-uuid-1');
    expect(d).toBeDefined();
    expect(d!.caller_jid).toBe('main@g.us');
    expect(d!.target_jid).toBe('other@g.us');
    expect(d!.status).toBe('pending');
  });

  it('fulfills a delegation', () => {
    createDelegation({
      uuid: 'test-uuid-2',
      caller_jid: 'main@g.us',
      target_jid: 'other@g.us',
      created_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2026-04-01T00:05:00.000Z',
      status: 'pending',
    });

    fulfillDelegation('test-uuid-2');
    const d = getDelegationByUuid('test-uuid-2');
    expect(d!.status).toBe('fulfilled');
  });

  it('returns undefined for unknown UUID', () => {
    expect(getDelegationByUuid('nonexistent')).toBeUndefined();
  });
});

// --- delegate_to_group authorization ---

describe('delegate_to_group authorization', () => {
  it('main group can delegate to another group', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-uuid-1',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Do this task',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    const d = getDelegationByUuid('del-uuid-1');
    expect(d).toBeDefined();
    expect(d!.status).toBe('pending');
    expect(d!.caller_jid).toBe('main@g.us');
    expect(d!.target_jid).toBe('other@g.us');
  });

  it('non-main group cannot delegate', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-uuid-blocked',
        callerJid: 'other@g.us',
        targetJid: 'third@g.us',
        prompt: 'Sneaky delegation',
        ttlSeconds: 300,
      },
      'other-group',
      false,
      deps,
    );

    expect(getDelegationByUuid('del-uuid-blocked')).toBeUndefined();
  });

  it('rejects delegation to unregistered target', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-uuid-unknown',
        callerJid: 'main@g.us',
        targetJid: 'unknown@g.us',
        prompt: 'No target',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getDelegationByUuid('del-uuid-unknown')).toBeUndefined();
  });
});

// --- delegate_to_group message injection ---

describe('delegate_to_group message injection', () => {
  it('stores a user message in target group DB', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-msg-1',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Please analyze this data',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    // The message should be stored as a non-bot user message in the target group
    const msgs = getMessagesSince(
      'other@g.us',
      '2020-01-01T00:00:00.000Z',
      'Andy',
    );
    const delegationMsg = msgs.find((m) =>
      m.content.includes('Delegation UUID: del-msg-1'),
    );
    expect(delegationMsg).toBeDefined();
    expect(delegationMsg!.content).toContain('Please analyze this data');
    expect(delegationMsg!.content).toContain('[Delegation UUID: del-msg-1');
  });

  it('calls enqueueMessageCheck on target JID', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-enqueue-1',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Wake up',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(enqueueMessageCheck).toHaveBeenCalledWith('other@g.us');
  });

  it('uses default TTL when ttlSeconds is missing', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'del-default-ttl',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Default TTL test',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const d = getDelegationByUuid('del-default-ttl');
    expect(d).toBeDefined();
    // expires_at should be ~300s after created_at
    const created = new Date(d!.created_at).getTime();
    const expires = new Date(d!.expires_at).getTime();
    expect(expires - created).toBe(300 * 1000);
  });
});

// --- respond_to_group ---

describe('respond_to_group', () => {
  beforeEach(() => {
    // Create a pending delegation for each test
    const now = new Date();
    createDelegation({
      uuid: 'resp-uuid-1',
      caller_jid: 'main@g.us',
      target_jid: 'other@g.us',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 300_000).toISOString(),
      status: 'pending',
    });
  });

  it('valid response routes message to caller and fulfills delegation', async () => {
    await processTaskIpc(
      {
        type: 'respond_to_group',
        uuid: 'resp-uuid-1',
        responseText: 'Here is the result',
      },
      'other-group', // sourceGroup matches target_jid's folder
      false,
      deps,
    );

    // Delegation should be fulfilled
    const d = getDelegationByUuid('resp-uuid-1');
    expect(d!.status).toBe('fulfilled');

    // Response message should be in caller's DB
    const msgs = getMessagesSince(
      'main@g.us',
      '2020-01-01T00:00:00.000Z',
      'Andy',
    );
    const responseMsg = msgs.find((m) =>
      m.content.includes('Delegation Response'),
    );
    expect(responseMsg).toBeDefined();
    expect(responseMsg!.content).toContain('Here is the result');
    expect(responseMsg!.content).toContain('UUID: resp-uuid-1');
    expect(responseMsg!.content).toContain('From: Other');

    // enqueueMessageCheck should be called on caller JID
    expect(enqueueMessageCheck).toHaveBeenCalledWith('main@g.us');
  });

  it('rejects response from wrong group', async () => {
    await processTaskIpc(
      {
        type: 'respond_to_group',
        uuid: 'resp-uuid-1',
        responseText: 'Impersonation attempt',
      },
      'third-group', // Wrong group — delegation was for other-group
      false,
      deps,
    );

    const d = getDelegationByUuid('resp-uuid-1');
    expect(d!.status).toBe('pending'); // Not fulfilled
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('rejects response for unknown UUID', async () => {
    await processTaskIpc(
      {
        type: 'respond_to_group',
        uuid: 'nonexistent-uuid',
        responseText: 'No such delegation',
      },
      'other-group',
      false,
      deps,
    );

    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('rejects response for already fulfilled delegation', async () => {
    // Fulfill it first
    fulfillDelegation('resp-uuid-1');

    await processTaskIpc(
      {
        type: 'respond_to_group',
        uuid: 'resp-uuid-1',
        responseText: 'Duplicate response',
      },
      'other-group',
      false,
      deps,
    );

    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('rejects response for expired delegation', async () => {
    // Create an already-expired delegation
    const past = new Date(Date.now() - 60_000);
    createDelegation({
      uuid: 'expired-uuid',
      caller_jid: 'main@g.us',
      target_jid: 'other@g.us',
      created_at: new Date(past.getTime() - 300_000).toISOString(),
      expires_at: past.toISOString(), // Already expired
      status: 'pending',
    });

    await processTaskIpc(
      {
        type: 'respond_to_group',
        uuid: 'expired-uuid',
        responseText: 'Too late',
      },
      'other-group',
      false,
      deps,
    );

    const d = getDelegationByUuid('expired-uuid');
    expect(d!.status).toBe('pending'); // Not fulfilled
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});

// --- Edge cases ---

describe('delegation edge cases', () => {
  it('multiple delegations to same target get independent UUIDs', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'multi-1',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Task A',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'multi-2',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Task B',
        ttlSeconds: 300,
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getDelegationByUuid('multi-1')).toBeDefined();
    expect(getDelegationByUuid('multi-2')).toBeDefined();
    expect(getDelegationByUuid('multi-1')!.uuid).not.toBe(
      getDelegationByUuid('multi-2')!.uuid,
    );
  });

  it('delegate_to_group with missing fields is rejected', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'incomplete',
        // Missing callerJid, targetJid, prompt
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getDelegationByUuid('incomplete')).toBeUndefined();
  });

  it('respond_to_group with missing fields is rejected', async () => {
    await processTaskIpc(
      {
        type: 'respond_to_group',
        // Missing uuid and responseText
      },
      'other-group',
      false,
      deps,
    );

    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('TTL is clamped to default when out of range', async () => {
    await processTaskIpc(
      {
        type: 'delegate_to_group',
        uuid: 'ttl-clamp',
        callerJid: 'main@g.us',
        targetJid: 'other@g.us',
        prompt: 'Clamped TTL',
        ttlSeconds: 5, // Below minimum of 30
      },
      'whatsapp_main',
      true,
      deps,
    );

    const d = getDelegationByUuid('ttl-clamp');
    expect(d).toBeDefined();
    const created = new Date(d!.created_at).getTime();
    const expires = new Date(d!.expires_at).getTime();
    // Should use default 300s, not the invalid 5s
    expect(expires - created).toBe(300 * 1000);
  });
});
