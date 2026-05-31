import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup, RegisteredGroupSnapshot } from './container-runner.js';
import {
  createDelegation,
  createTask,
  deleteTask,
  fulfillDelegation,
  getDelegationByUuid,
  getTaskById,
  getTasksForGroup,
  storeDashboardChatMessage,
  storeMessageDirect,
  updateTask,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { deriveRuntimeState } from './task-runtime-state.js';
import { RegisteredGroup, ScheduledTaskWithRuntime } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendAttachment: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredGroups: RegisteredGroupSnapshot[],
  ) => void;
  onTasksChanged: () => void;
  enqueueMessageCheck: (jid: string) => void;
  queue?: GroupQueue;
}

// --- Command approval state ---

interface PendingApproval {
  sourceGroup: string;
  timestamp: number;
  ttl: number; // seconds
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Check if an inbound user message is an approval response.
 * Returns true if the message was consumed (should NOT be forwarded to agent).
 */
export function checkApprovalResponse(
  chatJid: string,
  messageText: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): boolean {
  const pending = pendingApprovals.get(chatJid);
  if (!pending) return false;

  const trimmed = messageText.trim().toLowerCase();
  const approveWords = ['yes', 'approve', 'y'];
  const denyWords = ['no', 'deny', 'n'];

  const isApprove = approveWords.includes(trimmed);
  const isDeny = denyWords.includes(trimmed);

  if (!isApprove && !isDeny) return false;

  // Write approval response to the group's IPC input directory
  const inputDir = path.join(DATA_DIR, 'ipc', pending.sourceGroup, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const responsePath = path.join(inputDir, '_approval_response');
  fs.writeFileSync(
    responsePath,
    JSON.stringify({ type: 'approval_response', approved: isApprove }),
  );

  pendingApprovals.delete(chatJid);

  // Send confirmation (fire-and-forget)
  const confirmMsg = isApprove ? '✅ Command approved' : '❌ Command denied';
  sendMessage(chatJid, confirmMsg).catch(() => {});

  logger.info(
    { chatJid, sourceGroup: pending.sourceGroup, approved: isApprove },
    'Approval response written',
  );

  return true;
}

/**
 * Clean up expired pending approvals. Called from the IPC poll loop.
 */
function cleanupExpiredApprovals(): void {
  const now = Date.now();
  for (const [jid, pending] of pendingApprovals) {
    const expiresAt = pending.timestamp + pending.ttl * 1000;
    if (now >= expiresAt) {
      // Auto-deny: write rejection response
      const inputDir = path.join(DATA_DIR, 'ipc', pending.sourceGroup, 'input');
      fs.mkdirSync(inputDir, { recursive: true });
      const responsePath = path.join(inputDir, '_approval_response');
      fs.writeFileSync(
        responsePath,
        JSON.stringify({ type: 'approval_response', approved: false }),
      );

      pendingApprovals.delete(jid);
      logger.info(
        { chatJid: jid, sourceGroup: pending.sourceGroup },
        'Approval request expired, auto-denied',
      );
    }
  }
}

// --- Request/Response IPC helpers ---

/**
 * Write a response file for a request/response IPC exchange.
 * The response is written to the same tasks directory the request came from.
 */
function writeIpcResponse(
  groupFolder: string,
  correlationId: string,
  data: { ok: true; data: unknown } | { ok: false; error: string },
): void {
  const tasksDir = path.join(DATA_DIR, 'ipc', groupFolder, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const respPath = path.join(tasksDir, `${correlationId}.resp.json`);
  const tempPath = `${respPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ correlationId, ...data }));
  fs.renameSync(tempPath, respPath);
}

/**
 * Check if a filename is a request file (correlation-based request/response pattern).
 */
function isRequestFile(filename: string): boolean {
  return filename.endsWith('.req.json');
}

/**
 * Process a request/response IPC file.
 * Dispatches to type-specific handlers (added in BE_05/BE_06/BE_08).
 * Returns a structured response written back to the caller's tasks directory.
 */
export async function processTaskIpcRequest(
  data: {
    type: string;
    correlationId: string;
    groupFolder?: string;
    isMain?: boolean;
    [key: string]: unknown;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const { type, correlationId } = data;

  if (!correlationId) {
    logger.warn({ type, sourceGroup }, 'IPC request missing correlationId');
    return;
  }

  // Dispatch by request type — handlers added in subsequent tasks
  switch (type) {
    case 'list_tasks_request': {
      const tasks = getTasksForGroup(sourceGroup);
      const now = new Date();
      const decorated: ScheduledTaskWithRuntime[] = tasks.map((task) => ({
        ...task,
        runtime_state: deps.queue
          ? deriveRuntimeState(task, deps.queue, now)
          : null,
      }));
      writeIpcResponse(sourceGroup, correlationId, {
        ok: true,
        data: decorated,
      });
      break;
    }
    case 'get_task_request': {
      const taskId = data.taskId as string | undefined;
      if (!taskId) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
      } else {
        const now = new Date();
        const decorated: ScheduledTaskWithRuntime = {
          ...task,
          runtime_state: deps.queue
            ? deriveRuntimeState(task, deps.queue, now)
            : null,
        };
        writeIpcResponse(sourceGroup, correlationId, {
          ok: true,
          data: decorated,
        });
      }
      break;
    }
    case 'search_tasks_request': {
      const query = data.query as string | undefined;
      const useRegex = data.regex === true;

      if (!query) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Missing query parameter',
        });
        break;
      }

      const tasks = getTasksForGroup(sourceGroup);

      let matcher: (
        haystack: string,
      ) => { index: number; length: number } | null;
      if (useRegex) {
        let re: RegExp;
        try {
          re = new RegExp(query, 'i');
        } catch (e) {
          writeIpcResponse(sourceGroup, correlationId, {
            ok: false,
            error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
          });
          break;
        }
        matcher = (haystack) => {
          const m = re.exec(haystack);
          return m ? { index: m.index, length: m[0].length } : null;
        };
      } else {
        const lowerQuery = query.toLowerCase();
        matcher = (haystack) => {
          const idx = haystack.toLowerCase().indexOf(lowerQuery);
          return idx >= 0 ? { index: idx, length: lowerQuery.length } : null;
        };
      }

      const results: Array<{
        id: string;
        description: string | null;
        schedule_type: string;
        schedule_value: string;
        contextPreview: string;
      }> = [];
      const MAX_RESULTS = 50;

      for (const task of tasks) {
        if (results.length >= MAX_RESULTS) break;

        const haystack = `${task.description ?? ''}\n${task.prompt}\n${task.script ?? ''}`;
        const match = matcher(haystack);
        if (match) {
          const start = Math.max(0, match.index - 40);
          const end = Math.min(
            haystack.length,
            match.index + match.length + 40,
          );
          let preview = haystack.slice(start, end).replace(/\n/g, ' ');
          if (start > 0) preview = `...${preview}`;
          if (end < haystack.length) preview = `${preview}...`;

          results.push({
            id: task.id,
            description: task.description ?? null,
            schedule_type: task.schedule_type,
            schedule_value: task.schedule_value,
            contextPreview: preview,
          });
        }
      }

      writeIpcResponse(sourceGroup, correlationId, { ok: true, data: results });
      break;
    }
    case 'pause_task_request': {
      const taskId = data.taskId as string | undefined;
      if (!taskId) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      updateTask(taskId, { status: 'paused' });
      const updatedTask = getTaskById(taskId);
      writeIpcResponse(sourceGroup, correlationId, {
        ok: true,
        data: updatedTask,
      });
      logger.info({ taskId, sourceGroup }, 'Task paused via IPC request');
      deps.onTasksChanged();
      break;
    }
    case 'resume_task_request': {
      const taskId = data.taskId as string | undefined;
      if (!taskId) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      // Resume: set status to active and recompute next_run
      const resumeUpdates: Parameters<typeof updateTask>[1] = {
        status: 'active',
      };
      if (task.schedule_type === 'cron') {
        try {
          const interval = CronExpressionParser.parse(task.schedule_value, {
            tz: TIMEZONE,
          });
          resumeUpdates.next_run = interval.next().toISOString();
        } catch {
          writeIpcResponse(sourceGroup, correlationId, {
            ok: false,
            error: `Invalid schedule_value: cannot parse cron "${task.schedule_value}"`,
          });
          break;
        }
      } else if (task.schedule_type === 'interval') {
        const ms = parseInt(task.schedule_value, 10);
        if (!isNaN(ms) && ms > 0) {
          resumeUpdates.next_run = new Date(Date.now() + ms).toISOString();
        }
      }
      updateTask(taskId, resumeUpdates);
      const resumedTask = getTaskById(taskId);
      writeIpcResponse(sourceGroup, correlationId, {
        ok: true,
        data: resumedTask,
      });
      logger.info({ taskId, sourceGroup }, 'Task resumed via IPC request');
      deps.onTasksChanged();
      break;
    }
    case 'cancel_task_request': {
      const taskId = data.taskId as string | undefined;
      if (!taskId) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      // Capture pre-deletion record, then delete
      deleteTask(taskId);
      writeIpcResponse(sourceGroup, correlationId, { ok: true, data: task });
      logger.info({ taskId, sourceGroup }, 'Task cancelled via IPC request');
      deps.onTasksChanged();
      break;
    }
    case 'update_task_request': {
      const taskId = data.taskId as string | undefined;
      if (!taskId) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }
      const task = getTaskById(taskId);
      if (!task || task.group_folder !== sourceGroup) {
        writeIpcResponse(sourceGroup, correlationId, {
          ok: false,
          error: 'Task not found',
        });
        break;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (data.description !== undefined)
        updates.description = data.description as string;
      if (data.prompt !== undefined) updates.prompt = data.prompt as string;
      if (data.script !== undefined)
        updates.script = (data.script as string) || null;
      if (data.schedule_type !== undefined)
        updates.schedule_type = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once';
      if (data.schedule_value !== undefined)
        updates.schedule_value = data.schedule_value as string;
      if (data.context_mode !== undefined)
        updates.context_mode = data.context_mode as 'group' | 'isolated';

      // Recompute next_run if schedule changed
      if (
        data.schedule_type !== undefined ||
        data.schedule_value !== undefined
      ) {
        const merged = { ...task, ...updates };
        if (merged.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(merged.schedule_value, {
              tz: TIMEZONE,
            });
            updates.next_run = interval.next().toISOString();
          } catch {
            writeIpcResponse(sourceGroup, correlationId, {
              ok: false,
              error: `Invalid schedule_value: cannot parse cron "${merged.schedule_value}"`,
            });
            break;
          }
        } else if (merged.schedule_type === 'interval') {
          const ms = parseInt(merged.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            writeIpcResponse(sourceGroup, correlationId, {
              ok: false,
              error: `Invalid schedule_value: interval must be a positive number, got "${merged.schedule_value}"`,
            });
            break;
          }
          updates.next_run = new Date(Date.now() + ms).toISOString();
        } else if (merged.schedule_type === 'once') {
          const date = new Date(merged.schedule_value);
          if (isNaN(date.getTime())) {
            writeIpcResponse(sourceGroup, correlationId, {
              ok: false,
              error: `Invalid schedule_value: cannot parse timestamp "${merged.schedule_value}"`,
            });
            break;
          }
          updates.next_run = date.toISOString();
        }
      }

      updateTask(taskId, updates);
      const updatedTask = getTaskById(taskId);
      writeIpcResponse(sourceGroup, correlationId, {
        ok: true,
        data: updatedTask,
      });
      logger.info(
        { taskId, sourceGroup, updates },
        'Task updated via IPC request',
      );
      deps.onTasksChanged();
      break;
    }
    default:
      writeIpcResponse(sourceGroup, correlationId, {
        ok: false,
        error: `Unknown request type: ${type}`,
      });
      logger.warn(
        { type, correlationId, sourceGroup },
        'Unknown IPC request type',
      );
      break;
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain and folder→isAdmin lookups from registered groups
    const folderIsMain = new Map<string, boolean>();
    const folderIsAdmin = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
      if (group.isAdmin) folderIsAdmin.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const isAdmin = folderIsAdmin.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processIpcMessageData(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json') && !f.endsWith('.resp.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (isRequestFile(file)) {
                // Request/response pattern — handle and write response (don't delete; container cleans up)
                await processTaskIpcRequest(data, sourceGroup, isMain, deps);
                // Delete the request file after processing
                fs.unlinkSync(filePath);
              } else {
                // Fire-and-forget pattern (existing behavior)
                await processTaskIpc(data, sourceGroup, isMain, isAdmin, deps);
                fs.unlinkSync(filePath);
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    // Clean up expired approval requests (auto-deny on timeout)
    cleanupExpiredApprovals();

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Process a single parsed IPC message payload.
 * Exported for testing.
 */
export async function processIpcMessageData(
  data: {
    type: string;
    chatJid?: string;
    text?: string;
    source?: string;
    sender_name?: string;
    sender?: string;
    // attachment fields
    filePath?: string;
    caption?: string;
    // approval_request fields
    command?: string;
    patterns?: Array<{ name: string; description: string; matched: string }>;
    targetPaths?: string[];
    timestamp?: number;
    ttl?: number;
    groupFolder?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  // --- Handle attachment messages from send_attachment MCP tool ---
  if (data.type === 'attachment') {
    if (!data.chatJid || !data.filePath) return;

    // Resolve container path to host path
    // /workspace/group/... → groups/{sourceGroup}/...
    const relativePath = data.filePath.replace(/^\/workspace\/group\//, '');
    const hostPath = path.join(
      resolveGroupFolderPath(sourceGroup),
      relativePath,
    );

    if (!fs.existsSync(hostPath)) {
      logger.warn(
        { hostPath, containerPath: data.filePath, sourceGroup },
        'Attachment file not found on host',
      );
      return;
    }

    // Security: verify resolved path is within the group folder
    const resolvedHost = path.resolve(hostPath);
    const groupDir = path.resolve(resolveGroupFolderPath(sourceGroup));
    if (!resolvedHost.startsWith(groupDir)) {
      logger.warn(
        { hostPath, sourceGroup },
        'Attachment path escapes group folder',
      );
      return;
    }

    // Route to channel
    try {
      await deps.sendAttachment(data.chatJid, resolvedHost, data.caption);
    } catch (err) {
      logger.error(
        { err, chatJid: data.chatJid, hostPath },
        'Failed to send attachment',
      );
    }
    return;
  }

  // --- Handle approval requests from execute_command MCP tool ---
  if (data.type === 'approval_request') {
    if (!data.chatJid || !data.command) return;

    const patternDescs =
      data.patterns?.map((p) => p.description).join(', ') || 'unknown risk';
    const targets = data.targetPaths?.join(', ') || 'unknown paths';
    const ttl = data.ttl || 120;
    const approvalMsg = [
      '⚠️ Command requires approval:',
      '',
      `Command: \`${data.command}\``,
      `Risk: ${patternDescs}`,
      `Targets: ${targets} (write-mounted)`,
      '',
      'Reply "yes" to approve, "no" to deny.',
      `Auto-deny in ${ttl}s.`,
    ].join('\n');

    // If there's already a pending approval for this JID, auto-deny the old one
    const existingPending = pendingApprovals.get(data.chatJid);
    if (existingPending) {
      const inputDir = path.join(
        DATA_DIR,
        'ipc',
        existingPending.sourceGroup,
        'input',
      );
      fs.mkdirSync(inputDir, { recursive: true });
      const responsePath = path.join(inputDir, '_approval_response');
      fs.writeFileSync(
        responsePath,
        JSON.stringify({ type: 'approval_response', approved: false }),
      );
      logger.info(
        { chatJid: data.chatJid, sourceGroup: existingPending.sourceGroup },
        'Previous pending approval auto-denied (replaced by new request)',
      );
    }

    try {
      await deps.sendMessage(data.chatJid, approvalMsg);
    } catch (err) {
      // No channel for this JID — fail-closed (auto-deny)
      logger.warn(
        { chatJid: data.chatJid, sourceGroup, err },
        'Approval request: no channel for JID, auto-denying',
      );
      const inputDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');
      fs.mkdirSync(inputDir, { recursive: true });
      const responsePath = path.join(inputDir, '_approval_response');
      fs.writeFileSync(
        responsePath,
        JSON.stringify({ type: 'approval_response', approved: false }),
      );
      return;
    }

    pendingApprovals.set(data.chatJid, {
      sourceGroup,
      timestamp: data.timestamp || Date.now(),
      ttl,
    });

    logger.info(
      { chatJid: data.chatJid, sourceGroup, command: data.command },
      'Approval request sent to user',
    );
    return;
  }

  // --- Handle regular messages ---
  if (data.type !== 'message' || !data.chatJid || !data.text) return;

  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];

  const isDashboardSource = data.source === 'dashboard';
  if (
    !isDashboardSource &&
    !isMain &&
    !(targetGroup && targetGroup.folder === sourceGroup)
  ) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
    return;
  }

  // Skip sendMessage for dashboard-originated messages: the dashboard
  // channel has no external platform to forward to, and calling
  // sendMessage would store the user's text as a bot response (echo).
  // Also skip for dashboard targets: DashboardChannel.sendMessage also
  // writes to the DB, causing duplicate records with different sender names.
  // Let storeMessageDirect below be the single source of truth for dashboard.
  const isDashboardTarget = data.chatJid.endsWith('@internal');
  if (data.source !== 'dashboard' && !isDashboardTarget) {
    await deps.sendMessage(data.chatJid, data.text);
  }

  const senderSource = data.source || sourceGroup;
  // Priority: sender (from MCP tool) > sender_name (from IPC) > source
  const senderName = data.sender || data.sender_name || senderSource;

  // Dashboard messages are user messages, not bot messages.
  // They must be stored with is_from_me: false so the message loop
  // processes them and the agent responds.
  const isDashboardMessage = isDashboardSource;

  const msgId = `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const msgTimestamp = new Date().toISOString();

  storeMessageDirect({
    id: msgId,
    chat_jid: data.chatJid,
    sender: `${senderSource}@ipc`,
    sender_name: senderName,
    content: data.text,
    timestamp: msgTimestamp,
    is_from_me: !isDashboardMessage,
    is_bot_message: !isDashboardMessage,
  });

  // Also mirror dashboard user inputs to dashboard_chat_log for the chat UI
  if (isDashboardMessage || isDashboardTarget) {
    storeDashboardChatMessage({
      id: msgId,
      chat_jid: data.chatJid,
      sender: `${senderSource}@ipc`,
      sender_name: senderName,
      content: data.text,
      timestamp: msgTimestamp,
      is_from_user: true,
    });
  }

  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    description?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    multiAgentRouter?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For delegate_to_group
    uuid?: string;
    callerJid?: string;
    ttlSeconds?: number;
    // For respond_to_group
    responseText?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  isAdmin: boolean, // Verified from directory path — admin tier
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          description: data.description || null,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    // Stale container fallback: mutation tools moved to request/response in v1.21.
    // If a pre-v1.21 container writes these as fire-and-forget, log a warning and ignore.
    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
    case 'update_task':
      logger.warn(
        { type: data.type, sourceGroup },
        'Stale container: mutation type received without _request suffix; rebuild container to v1.21+',
      );
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        const registeredGroupsList = Object.entries(registeredGroups).map(
          ([jid, g]) => ({
            jid,
            name: g.name,
            folder: g.folder,
            isMain: g.isMain === true,
          }),
        );
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          registeredGroupsList,
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only admin group can register new groups
      if (!isAdmin) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked (admin only)',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Folder-collision pre-check: reject if folder is already used by a different JID
        const folderConflict = Object.entries(registeredGroups).some(
          ([jid, g]) => g.folder === data.folder && jid !== data.jid,
        );
        if (folderConflict) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'register_group rejected — folder already used by another group',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain or isAdmin via IPC.
        // Preserve isMain/isAdmin from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flags.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          multiAgentRouter: data.multiAgentRouter,
          isMain: existingGroup?.isMain,
          isAdmin: existingGroup?.isAdmin,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'delegate_to_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delegate_to_group attempt blocked',
        );
        break;
      }
      if (!data.uuid || !data.prompt || !data.targetJid || !data.callerJid) {
        logger.warn(
          { data: { type: data.type } },
          'Invalid delegate_to_group — missing fields',
        );
        break;
      }
      const delegateTarget = registeredGroups[data.targetJid];
      if (!delegateTarget) {
        logger.warn(
          { targetJid: data.targetJid },
          'Cannot delegate: target group not registered',
        );
        break;
      }
      const ttl =
        data.ttlSeconds && data.ttlSeconds >= 30 && data.ttlSeconds <= 3600
          ? data.ttlSeconds
          : 300;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      createDelegation({
        uuid: data.uuid,
        caller_jid: data.callerJid,
        target_jid: data.targetJid,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        status: 'pending',
      });

      // Resolve caller group name for the sender_name field
      const callerGroup = registeredGroups[data.callerJid];
      const callerName = callerGroup?.name || 'Delegation';

      storeMessageDirect({
        id: `delegation-${data.uuid}`,
        chat_jid: data.targetJid,
        sender: `${callerName}@delegation`,
        sender_name: callerName,
        content: `${data.prompt}\n\n[Delegation UUID: ${data.uuid} — use respond_to_group to send your response]`,
        timestamp: now.toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      deps.enqueueMessageCheck(data.targetJid);
      logger.info(
        {
          uuid: data.uuid,
          callerJid: data.callerJid,
          targetJid: data.targetJid,
          ttl,
        },
        'Delegation created via IPC',
      );
      break;
    }

    case 'respond_to_group': {
      if (!data.uuid || !data.responseText) {
        logger.warn(
          { data: { type: data.type } },
          'Invalid respond_to_group — missing fields',
        );
        break;
      }
      const delegation = getDelegationByUuid(data.uuid);
      if (!delegation) {
        logger.warn({ uuid: data.uuid }, 'Delegation not found');
        break;
      }

      // Resolve sourceGroup folder → JID for authorization
      let responderJid: string | undefined;
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === sourceGroup) {
          responderJid = jid;
          break;
        }
      }
      if (!responderJid || responderJid !== delegation.target_jid) {
        logger.warn(
          {
            uuid: data.uuid,
            sourceGroup,
            expectedTarget: delegation.target_jid,
          },
          'Unauthorized respond_to_group — wrong responder',
        );
        break;
      }

      if (delegation.status !== 'pending') {
        logger.warn(
          { uuid: data.uuid, status: delegation.status },
          'Delegation already resolved',
        );
        break;
      }

      if (new Date(delegation.expires_at) <= new Date()) {
        logger.warn(
          { uuid: data.uuid, expiresAt: delegation.expires_at },
          'Delegation expired',
        );
        break;
      }

      fulfillDelegation(data.uuid);

      const targetGroupEntry = registeredGroups[delegation.target_jid];
      const targetGroupName = targetGroupEntry?.name || 'Unknown';

      const responseId = `delegation-response-${data.uuid}`;
      const responseTimestamp = new Date().toISOString();
      const responseContent = `[Delegation Response — UUID: ${data.uuid}]\n[From: ${targetGroupName}]\n${data.responseText}`;

      storeMessageDirect({
        id: responseId,
        chat_jid: delegation.caller_jid,
        sender: `${targetGroupName}@delegation`,
        sender_name: targetGroupName,
        content: responseContent,
        timestamp: responseTimestamp,
        is_from_me: false,
        is_bot_message: false,
      });

      // Also write to dashboard_chat_log if the caller is a dashboard group
      if (delegation.caller_jid.endsWith('@internal')) {
        storeDashboardChatMessage({
          id: responseId,
          chat_jid: delegation.caller_jid,
          sender: `${targetGroupName}@delegation`,
          sender_name: targetGroupName,
          content: responseContent,
          timestamp: responseTimestamp,
          is_from_user: false,
        });
      }

      deps.enqueueMessageCheck(delegation.caller_jid);
      logger.info(
        { uuid: data.uuid, callerJid: delegation.caller_jid, responderJid },
        'Delegation response routed via IPC',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
