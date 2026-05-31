/**
 * Step: unregister — Remove a registered group with transactional cleanup.
 *
 * CLI-only by design — no MCP/IPC removal verb exists.
 * Tasks are either deleted or relocated to another group (operator choice).
 * On-disk files (groups/{folder}/, sessions, ipc) are NOT deleted (soft removal).
 */
import readline from 'readline';

import {
  initDatabase,
  getAllRegisteredGroups,
  getTasksForGroup,
  deleteTask,
  deleteSession,
  deleteRegisteredGroup,
  relocateTasks,
  runInTransaction,
} from '../src/db.ts';
import { logger } from '../src/logger.ts';
import { emitStatus } from './status.ts';

type TaskAction = 'delete' | 'relocate' | 'abort';

interface UnregisterArgs {
  jid: string;
  folder: string;
  tasks: TaskAction | '';
  relocateTo: string;
  yes: boolean;
}

function parseArgs(args: string[]): UnregisterArgs {
  const result: UnregisterArgs = {
    jid: '',
    folder: '',
    tasks: '',
    relocateTo: '',
    yes: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--tasks':
        result.tasks = (args[++i] || '') as TaskAction;
        break;
      case '--relocate-to':
        result.relocateTo = args[++i] || '';
        break;
      case '--yes':
      case '-y':
        result.yes = true;
        break;
    }
  }

  return result;
}

function fail(error: string, detail?: string): never {
  emitStatus('UNREGISTER_CHANNEL', { STATUS: 'failed', ERROR: error });
  if (detail) logger.error(detail);
  process.exit(1);
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  // Exactly one of --jid or --folder required
  if ((!parsed.jid && !parsed.folder) || (parsed.jid && parsed.folder)) {
    fail('missing_required_args', 'Provide exactly one of --jid or --folder');
  }

  // Validate --tasks value if provided
  if (parsed.tasks && !['delete', 'relocate', 'abort'].includes(parsed.tasks)) {
    fail('invalid_tasks_action', `--tasks must be delete, relocate, or abort (got: ${parsed.tasks})`);
  }

  // relocate-to required when tasks=relocate
  if (parsed.tasks === 'relocate' && !parsed.relocateTo) {
    fail('missing_relocate_target', '--relocate-to is required when --tasks relocate');
  }

  initDatabase();

  // Resolve target group
  const allGroups = getAllRegisteredGroups();
  let targetJid = '';
  let targetFolder = '';

  if (parsed.jid) {
    if (!allGroups[parsed.jid]) {
      fail('group_not_found', `No registered group with JID: ${parsed.jid}`);
    }
    targetJid = parsed.jid;
    targetFolder = allGroups[parsed.jid].folder;
  } else {
    const entry = Object.entries(allGroups).find(([, g]) => g.folder === parsed.folder);
    if (!entry) {
      fail('group_not_found', `No registered group with folder: ${parsed.folder}`);
    }
    targetJid = entry[0];
    targetFolder = entry[1].folder;
  }

  const group = allGroups[targetJid];
  const tasks = getTasksForGroup(targetFolder);

  // Print summary
  console.log(`\nGroup: ${group.name} (${targetJid})`);
  console.log(`Folder: ${targetFolder}`);
  console.log(`Tasks: ${tasks.length}`);
  if (tasks.length > 0) {
    console.log('\nScheduled tasks:');
    for (const t of tasks) {
      console.log(`  - [${t.id}] ${t.description || t.prompt.slice(0, 60)} (${t.schedule_type}: ${t.schedule_value})`);
    }
  }

  // Determine task action
  let taskAction: TaskAction = 'delete'; // default when no tasks
  let relocateToJid = '';
  let relocateToFolder = '';

  if (tasks.length > 0) {
    if (parsed.tasks) {
      taskAction = parsed.tasks;
    } else {
      // Interactive prompt needed
      const isTTY = process.stdin.isTTY;
      if (!isTTY) {
        fail('task_decision_required', 'Tasks exist and stdin is not a TTY. Provide --tasks delete|relocate|abort');
      }

      const answer = await promptUser('\nTasks exist. [d]elete all / [r]elocate to another group / [a]bort? ');
      if (answer === 'd' || answer === 'delete') {
        taskAction = 'delete';
      } else if (answer === 'r' || answer === 'relocate') {
        taskAction = 'relocate';
      } else {
        taskAction = 'abort';
      }
    }

    if (taskAction === 'abort') {
      emitStatus('UNREGISTER_CHANNEL', { STATUS: 'aborted', JID: targetJid, FOLDER: targetFolder });
      console.log('Aborted.');
      return;
    }

    if (taskAction === 'relocate') {
      relocateToJid = parsed.relocateTo;

      if (!relocateToJid) {
        const isTTY = process.stdin.isTTY;
        if (!isTTY) {
          fail('task_decision_required', 'Relocate target required. Provide --relocate-to <jid>');
        }
        relocateToJid = (await promptUser('Relocate to JID: ')).trim();
      }

      if (!relocateToJid || !allGroups[relocateToJid]) {
        fail('invalid_relocate_target', `Target JID not found in registered groups: ${relocateToJid}`);
      }
      if (relocateToJid === targetJid) {
        fail('invalid_relocate_target', 'Cannot relocate tasks to the group being removed');
      }
      relocateToFolder = allGroups[relocateToJid].folder;
    }
  } else {
    taskAction = 'delete'; // no tasks — proceed directly
  }

  // Confirmation (unless --yes)
  if (!parsed.yes) {
    const isTTY = process.stdin.isTTY;
    if (!isTTY) {
      // Non-interactive without --yes: proceed (flags were explicit)
    } else {
      const actionDesc = tasks.length === 0
        ? 'Remove group (no tasks)'
        : taskAction === 'delete'
          ? `Remove group + DELETE ${tasks.length} task(s)`
          : `Remove group + RELOCATE ${tasks.length} task(s) → ${relocateToJid}`;
      const confirm = await promptUser(`\n${actionDesc}. Proceed? [y/N] `);
      if (confirm !== 'y' && confirm !== 'yes') {
        emitStatus('UNREGISTER_CHANNEL', { STATUS: 'aborted', JID: targetJid, FOLDER: targetFolder });
        console.log('Aborted.');
        return;
      }
    }
  }

  // Transactional removal
  logger.info({ jid: targetJid, folder: targetFolder, taskAction }, 'Unregistering group');

  runInTransaction(() => {
    // Apply task decision
    if (tasks.length > 0) {
      if (taskAction === 'delete') {
        for (const t of tasks) {
          deleteTask(t.id);
        }
        logger.info({ count: tasks.length }, 'Deleted tasks');
      } else if (taskAction === 'relocate') {
        const moved = relocateTasks(targetFolder, relocateToFolder, relocateToJid);
        logger.info({ count: moved, to: relocateToJid }, 'Relocated tasks');
      }
    }

    // Remove session
    deleteSession(targetFolder);

    // Remove registration
    deleteRegisteredGroup(targetJid);
  });

  // Soft file handling — print paths for manual cleanup
  console.log('\nGroup removed from database.');
  console.log('\nOn-disk files NOT deleted (manual cleanup if desired):');
  console.log(`  groups/${targetFolder}/`);
  console.log(`  data/sessions/${targetFolder}/`);
  console.log(`  data/ipc/${targetFolder}/`);

  emitStatus('UNREGISTER_CHANNEL', {
    JID: targetJid,
    FOLDER: targetFolder,
    TASKS_ACTION: taskAction,
    TASKS_COUNT: tasks.length,
    ...(relocateToJid && { RELOCATED_TO: relocateToJid }),
    STATUS: 'success',
  });
}
