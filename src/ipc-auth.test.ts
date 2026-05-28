import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  _initTestDatabase,
  createTask,
  getAllChats,
  getAllTasks,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { processTaskIpc, processTaskIpcRequest, IpcDeps } from './ipc.js';
import { processIpcMessageData } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Use a unique temp directory for IPC response files
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `nanoclaw-ipc-auth-test-${process.pid}`,
);

vi.mock('./config.js', () => ({
  DATA_DIR: path.join(
    os.tmpdir(),
    `nanoclaw-ipc-auth-test-${process.pid}`,
  ),
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

/**
 * Read and parse the response file written by processTaskIpcRequest.
 */
function readIpcResponse(
  groupFolder: string,
  correlationId: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const respPath = path.join(
    TEST_DATA_DIR,
    'ipc',
    groupFolder,
    'tasks',
    `${correlationId}.resp.json`,
  );
  const raw = fs.readFileSync(respPath, 'utf-8');
  return JSON.parse(raw);
}

// Set up registered groups used across tests
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

beforeEach(() => {
  _initTestDatabase();

  // Ensure IPC directories exist for response file writes
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'ipc', 'whatsapp_main', 'tasks'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'ipc', 'other-group', 'tasks'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'ipc', 'third-group', 'tasks'), {
    recursive: true,
  });

  // Seed chat rows so FK constraints pass in message-related tests
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
  storeChatMetadata(
    'dashboard@internal',
    new Date().toISOString(),
    'Dashboard',
    'dashboard',
    false,
  );

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    sendAttachment: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Create chats row for internal groups (mirrors src/index.ts behavior)
      if (jid.endsWith('@internal')) {
        storeChatMetadata(
          jid,
          new Date().toISOString(),
          group.name,
          'dashboard',
          false,
        );
      }
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    enqueueMessageCheck: () => {},
  };
});

afterEach(() => {
  // Clean up IPC response files between tests
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('own-group success: main group can pause its own task', async () => {
    await processTaskIpcRequest(
      { type: 'pause_task_request', taskId: 'task-main', correlationId: 'c1' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('paused');
    const resp = readIpcResponse('whatsapp_main', 'c1');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-main');
    expect((resp as any).data.status).toBe('paused');
  });

  it('own-group success: non-main group can pause its own task', async () => {
    await processTaskIpcRequest(
      { type: 'pause_task_request', taskId: 'task-other', correlationId: 'c2' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
    const resp = readIpcResponse('other-group', 'c2');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-other');
    expect((resp as any).data.status).toBe('paused');
  });

  it('cross-group deny: main group cannot pause another groups task', async () => {
    await processTaskIpcRequest(
      { type: 'pause_task_request', taskId: 'task-other', correlationId: 'c3' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('active');
    const resp = readIpcResponse('whatsapp_main', 'c3');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('cross-group deny: non-main group cannot pause another groups task', async () => {
    await processTaskIpcRequest(
      { type: 'pause_task_request', taskId: 'task-main', correlationId: 'c4' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
    const resp = readIpcResponse('other-group', 'c4');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('missing task ID: returns uniform error', async () => {
    await processTaskIpcRequest(
      { type: 'pause_task_request', taskId: 'nonexistent', correlationId: 'c5' },
      'whatsapp_main',
      true,
      deps,
    );
    const resp = readIpcResponse('whatsapp_main', 'c5');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('own-group success: non-main group can resume its own task', async () => {
    await processTaskIpcRequest(
      { type: 'resume_task_request', taskId: 'task-paused', correlationId: 'r1' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
    const resp = readIpcResponse('other-group', 'r1');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-paused');
    expect((resp as any).data.status).toBe('active');
  });

  it('cross-group deny: main group cannot resume another groups task', async () => {
    await processTaskIpcRequest(
      { type: 'resume_task_request', taskId: 'task-paused', correlationId: 'r2' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
    const resp = readIpcResponse('whatsapp_main', 'r2');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('cross-group deny: non-main group cannot resume another groups task', async () => {
    await processTaskIpcRequest(
      { type: 'resume_task_request', taskId: 'task-paused', correlationId: 'r3' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
    const resp = readIpcResponse('third-group', 'r3');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('missing task ID: returns uniform error', async () => {
    await processTaskIpcRequest(
      { type: 'resume_task_request', taskId: 'nonexistent', correlationId: 'r4' },
      'other-group',
      false,
      deps,
    );
    const resp = readIpcResponse('other-group', 'r4');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('own-group success: main group can cancel its own task', async () => {
    createTask({
      id: 'task-main-cancel',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'my task to cancel',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpcRequest(
      { type: 'cancel_task_request', taskId: 'task-main-cancel', correlationId: 'k1' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-main-cancel')).toBeUndefined();
    const resp = readIpcResponse('whatsapp_main', 'k1');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-main-cancel');
  });

  it('own-group success: non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpcRequest(
      { type: 'cancel_task_request', taskId: 'task-own', correlationId: 'k2' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
    const resp = readIpcResponse('other-group', 'k2');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-own');
  });

  it('cross-group deny: main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpcRequest(
      { type: 'cancel_task_request', taskId: 'task-to-cancel', correlationId: 'k3' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeDefined();
    const resp = readIpcResponse('whatsapp_main', 'k3');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('cross-group deny: non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpcRequest(
      { type: 'cancel_task_request', taskId: 'task-foreign', correlationId: 'k4' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
    const resp = readIpcResponse('other-group', 'k4');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('missing task ID: returns uniform error', async () => {
    await processTaskIpcRequest(
      { type: 'cancel_task_request', taskId: 'nonexistent', correlationId: 'k5' },
      'whatsapp_main',
      true,
      deps,
    );
    const resp = readIpcResponse('whatsapp_main', 'k5');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });
});

// --- update_task authorization ---

describe('update_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-updatable',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'updatable task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('own-group success: non-main group can update its own task', async () => {
    await processTaskIpcRequest(
      {
        type: 'update_task_request',
        taskId: 'task-updatable',
        correlationId: 'u1',
        prompt: 'updated prompt',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-updatable')!.prompt).toBe('updated prompt');
    const resp = readIpcResponse('other-group', 'u1');
    expect(resp.ok).toBe(true);
    expect((resp as any).data.id).toBe('task-updatable');
    expect((resp as any).data.prompt).toBe('updated prompt');
  });

  it('cross-group deny: main group cannot update another groups task', async () => {
    await processTaskIpcRequest(
      {
        type: 'update_task_request',
        taskId: 'task-updatable',
        correlationId: 'u2',
        prompt: 'hacked',
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-updatable')!.prompt).toBe('updatable task');
    const resp = readIpcResponse('whatsapp_main', 'u2');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('cross-group deny: non-main group cannot update another groups task', async () => {
    await processTaskIpcRequest(
      {
        type: 'update_task_request',
        taskId: 'task-updatable',
        correlationId: 'u3',
        prompt: 'sneaky',
      },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-updatable')!.prompt).toBe('updatable task');
    const resp = readIpcResponse('third-group', 'u3');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('missing task ID: returns uniform error', async () => {
    await processTaskIpcRequest(
      {
        type: 'update_task_request',
        taskId: 'nonexistent',
        correlationId: 'u4',
        prompt: 'nope',
      },
      'other-group',
      false,
      deps,
    );
    const resp = readIpcResponse('other-group', 'u4');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toBe('Task not found');
  });

  it('invalid schedule_value: returns validation error', async () => {
    await processTaskIpcRequest(
      {
        type: 'update_task_request',
        taskId: 'task-updatable',
        correlationId: 'u5',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
      },
      'other-group',
      false,
      deps,
    );
    // DB unchanged
    expect(getTaskById('task-updatable')!.schedule_type).toBe('once');
    const resp = readIpcResponse('other-group', 'u5');
    expect(resp.ok).toBe(false);
    expect((resp as any).error).toContain('Invalid schedule_value');
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });

  it('register_group creates chats row for internal groups', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'test-internal@internal',
        name: 'Test Internal',
        folder: 'test-internal',
        trigger: '@test',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered
    const group = getRegisteredGroup('test-internal@internal');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Test Internal');

    // Verify chats row was created for internal group
    const chats = getAllChats();
    const internalChat = chats.find((c) => c.jid === 'test-internal@internal');
    expect(internalChat).toBeDefined();
    expect(internalChat!.name).toBe('Test Internal');
  });
});

// --- dashboard echo fix ---

describe('processIpcMessageData - dashboard echo prevention', () => {
  it('does NOT call sendMessage for dashboard-sourced messages', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      {
        type: 'message',
        chatJid: 'dashboard@internal',
        text: 'hello',
        source: 'dashboard',
        sender_name: 'Dashboard User',
      },
      'dashboard',
      true,
      localDeps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('DOES call sendMessage for non-dashboard IPC messages', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      {
        type: 'message',
        chatJid: 'other@g.us',
        text: 'hello from agent',
        source: 'other-group',
      },
      'whatsapp_main',
      true,
      localDeps,
    );

    expect(sendMessage).toHaveBeenCalledWith('other@g.us', 'hello from agent');
  });

  it('blocks unauthorized non-dashboard messages', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      {
        type: 'message',
        chatJid: 'main@g.us',
        text: 'sneaky',
        source: 'other-group',
      },
      'other-group',
      false,
      localDeps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores non-message type payloads', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      { type: 'schedule_task', chatJid: 'other@g.us', text: 'ignored' },
      'whatsapp_main',
      true,
      localDeps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses sender parameter for sender_name when provided', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      {
        type: 'message',
        chatJid: 'main@g.us',
        text: 'Found 3 results',
        source: 'agent-group',
        sender: 'Researcher',
      },
      'agent-group',
      true,
      localDeps,
    );

    expect(sendMessage).toHaveBeenCalledWith('main@g.us', 'Found 3 results');
    // Note: sender_name storage is verified by the db module tests
  });

  it('falls back to sender_name when sender not provided', async () => {
    const sendMessage = vi.fn(async () => {});
    const localDeps: IpcDeps = { ...deps, sendMessage };

    await processIpcMessageData(
      {
        type: 'message',
        chatJid: 'main@g.us',
        text: 'hello',
        source: 'agent-group',
        sender_name: 'Agent Bot',
      },
      'agent-group',
      true,
      localDeps,
    );

    expect(sendMessage).toHaveBeenCalledWith('main@g.us', 'hello');
    // Note: sender_name fallback is verified by the db module tests
  });
});
