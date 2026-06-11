import { afterAll, describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  setRegisteredGroup,
  setRouterState,
  shutdownDatabase,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';
import {
  loadCursors,
  getGlobalCursor,
  getGroupCursor,
  ZERO_CURSOR,
} from './cursor-state.js';
import type { Cursor } from './cursor-state.js';

beforeEach(async () => {
  await _initTestDatabase();
});

afterAll(async () => {
  await shutdownDatabase();
});

// Helper to store a message using the normalized NewMessage interface
async function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  await storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:00.000Z',
      id: '0',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:00.000Z',
      id: '0',
    });
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:00.000Z',
      id: '0',
    });
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    await store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:00.000Z',
      id: '0',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    await storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    await store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', async () => {
    // Cursor from m2: { ts: 00:00:02, id: 'm2' } — only m3 + m4 are newer
    const msgs = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:02.000Z',
      id: 'm2',
    });
    // Should exclude m1, m2 (before/at cursor); returns m3 (bot) + m4
    expect(msgs).toHaveLength(2);
  });

  it('no longer filters bot messages (messages table is now a pure input queue)', async () => {
    const msgs = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:00.000Z',
      id: '0',
    });
    // All 4 messages returned (no bot filtering)
    expect(msgs).toHaveLength(4);
  });

  it('returns all messages when sinceTimestamp is empty', async () => {
    const msgs = await getMessagesSince('group@g.us', { ts: '', id: '0' });
    // All 4 messages (no bot filtering)
    expect(msgs).toHaveLength(4);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', async () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      await store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: new Date(Date.UTC(2023, 0, 1, i)).toISOString(), // 2023-01-01 + i hours
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    await store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = await getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = await getMessagesSince(
      'group@g.us',
      { ts: recovered!, id: 'm3' },
      10,
    );
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', async () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      await store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = await getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = await getMessagesSince(
      'group@g.us',
      { ts: recovered!, id: 'm3' },
      10,
    );
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', async () => {
    // Use a fresh group with no bot messages
    await storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      await store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = await getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = await getMessagesSince('fresh@g.us', { ts: '', id: '0' }, 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('no longer filters messages with bot-like content prefix (backstop removed)', async () => {
    // Previously, messages starting with "Andy:" were filtered. Now they pass through
    // because the messages table is a pure input queue (no bot responses land here).
    await store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = await getMessagesSince('group@g.us', {
      ts: '2024-01-01T00:00:04.000Z',
      id: 'm4',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Andy: old bot reply');
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(async () => {
    await storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    await storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    await storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    await store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', async () => {
    const { messages, newCursor } = await getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      { ts: '2024-01-01T00:00:00.000Z', id: '0' },
    );
    // All 4 messages returned (no bot filtering)
    expect(messages).toHaveLength(4);
    expect(newCursor.ts).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', async () => {
    const { messages } = await getNewMessages(['group1@g.us', 'group2@g.us'], {
      ts: '2024-01-01T00:00:02.000Z',
      id: 'a2',
    });
    // a3 (bot reply at 00:00:03) + a4 (g1 msg2 at 00:00:04)
    expect(messages).toHaveLength(2);
  });

  it('returns empty for no registered groups', async () => {
    const { messages, newCursor } = await getNewMessages([], {
      ts: '',
      id: '0',
    });
    expect(messages).toHaveLength(0);
    expect(newCursor.ts).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = await getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', async () => {
    await storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'My Group',
    );
    const chats = await getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    await storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Updated Name',
    );
    const chats = await getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = await getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', async () => {
    await createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = await getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', async () => {
    await createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await updateTask('task-2', { status: 'paused' });
    expect((await getTaskById('task-2'))!.status).toBe('paused');
  });

  it('deletes a task and its run logs', async () => {
    await createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await deleteTask('task-3');
    expect(await getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      await store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', async () => {
    const { messages, newCursor } = await getNewMessages(
      ['group@g.us'],
      { ts: '2024-01-01T00:00:00.000Z', id: '0' },
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newCursor reflects latest returned row
    expect(newCursor.ts).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', async () => {
    const messages = await getMessagesSince(
      'group@g.us',
      { ts: '2024-01-01T00:00:00.000Z', id: '0' },
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', async () => {
    const { messages } = await getNewMessages(
      ['group@g.us'],
      { ts: '2024-01-01T00:00:00.000Z', id: '0' },
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', async () => {
    await setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = await getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', async () => {
    await setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = await getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Composite cursor regression tests ---

describe('composite cursor: same-timestamp stranding', () => {
  it('returns all rows with identical timestamps across multiple cursor advances', async () => {
    const jid = 'album-test@g.us';
    await storeChatMetadata(jid, '2024-01-01T00:00:00.000Z');

    const ts = '2026-06-11T07:35:14.000Z';

    // Insert 4 messages with identical timestamp (simulates Telegram album)
    for (let i = 1; i <= 4; i++) {
      await store({
        id: `album-${i}`,
        chat_jid: jid,
        sender: 'user1',
        sender_name: 'User',
        content: `[Photo]: /path/to/photo${i}.jpg`,
        timestamp: ts,
        is_from_me: false,
      });
    }

    // First poll with empty cursor — should return all 4
    const result1 = await getNewMessages([jid], { ts: '', id: '0' });
    expect(result1.messages).toHaveLength(4);
    expect(result1.newCursor.ts).toBe(ts);

    // Second poll with cursor from first — should return 0 (all seen)
    const result2 = await getNewMessages([jid], result1.newCursor);
    expect(result2.messages).toHaveLength(0);

    // Insert a 5th message with the SAME timestamp but higher ID
    await store({
      id: `album-5`,
      chat_jid: jid,
      sender: 'user1',
      sender_name: 'User',
      content: `[Photo]: /path/to/photo5.jpg`,
      timestamp: ts,
      is_from_me: false,
    });

    // Third poll — should return only the new message, not strand it
    const result3 = await getNewMessages([jid], result1.newCursor);
    expect(result3.messages).toHaveLength(1);
    expect(result3.messages[0].id).toBe('album-5');
  });
});

describe('composite cursor: bot-reply advancement', () => {
  it('getMessagesSince returns bot replies that callers must handle', async () => {
    const jid = 'bot-reply-test@g.us';
    await storeChatMetadata(jid, '2024-01-01T00:00:00.000Z');

    // User message
    await store({
      id: 'user-msg-1',
      chat_jid: jid,
      sender: 'user1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-06-11T08:00:00.000Z',
      is_from_me: false,
    });

    // Bot reply (later timestamp)
    await store({
      id: 'bot-reply-1',
      chat_jid: jid,
      sender: 'bot',
      sender_name: 'Bot',
      content: 'hi there',
      timestamp: '2026-06-11T08:00:01.000Z',
      is_from_me: true,
    });

    // Query since user message cursor — bot reply must appear
    const cursor: Cursor = { ts: '2026-06-11T08:00:00.000Z', id: 'user-msg-1' };
    const messages = await getMessagesSince(jid, cursor);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('bot-reply-1');
    expect(messages[0].is_from_me).toBe(true);

    // After caller advances cursor past bot reply, no messages remain
    const advancedCursor: Cursor = {
      ts: '2026-06-11T08:00:01.000Z',
      id: 'bot-reply-1',
    };
    const remaining = await getMessagesSince(jid, advancedCursor);
    expect(remaining).toHaveLength(0);
  });
});

describe('composite cursor: legacy migration', () => {
  it('loadCursors migrates legacy bare-timestamp to composite', async () => {
    // Simulate legacy state: bare timestamp string (not JSON)
    await setRouterState('last_timestamp', '2026-06-11T07:00:00.000Z');
    await setRouterState(
      'last_agent_timestamp',
      JSON.stringify({
        'group1@g.us': '2026-06-11T06:50:00.000Z',
      }),
    );

    await loadCursors();

    const global = getGlobalCursor();
    expect(global).toEqual({ ts: '2026-06-11T07:00:00.000Z', id: '0' });

    const group = getGroupCursor('group1@g.us');
    expect(group).toEqual({ ts: '2026-06-11T06:50:00.000Z', id: '0' });
  });
});
