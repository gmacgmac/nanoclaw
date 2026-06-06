import { getTriggerPattern } from './config.js';
import { storeMessageDirect } from './db.js';
import { getRegisteredGroups } from './group-registry.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';

// --- Types ---

export interface DelegationTarget {
  targetJid: string;
  targetGroup: RegisteredGroup;
}

// --- Pure Predicate ---

/**
 * Returns the target group if this message matches a sub-agent trigger,
 * or null if it doesn't. Used by all three filter sites.
 *
 * - Bot's own messages are never delegated (returns null).
 * - Skips the hub's own JID (a group can't delegate to itself).
 * - First match wins.
 */
export function findDelegationTarget(
  msg: NewMessage,
  hubJid: string,
): DelegationTarget | null {
  if (msg.is_from_me) return null;

  const content = msg.content.trim();

  for (const [targetJid, targetGroup] of Object.entries(
    getRegisteredGroups(),
  )) {
    if (targetJid === hubJid) continue;
    if (getTriggerPattern(targetGroup.trigger).test(content)) {
      return { targetJid, targetGroup };
    }
  }

  return null;
}

// --- Filter Helper ---

/**
 * Returns true if the message should be kept in the hub's stream
 * (i.e., it is NOT delegated to a sub-agent).
 */
export function isHubMessage(msg: NewMessage, hubJid: string): boolean {
  return findDelegationTarget(msg, hubJid) === null;
}

// --- Dispatch Action ---

export interface DelegateMessageArgs {
  hubGroup: RegisteredGroup;
  hubJid: string;
  msg: NewMessage;
  target: DelegationTarget;
  enqueueMessageCheck: (jid: string) => void;
}

/**
 * Dispatches a message to the target sub-agent:
 * strips trigger prefix, stores routed message in target DB, enqueues check, logs.
 */
export async function delegateMessage(args: DelegateMessageArgs): Promise<void> {
  const { hubGroup, hubJid, msg, target, enqueueMessageCheck } = args;

  const strippedPrompt = msg.content
    .trim()
    .replace(getTriggerPattern(target.targetGroup.trigger), '')
    .trim();

  const now = new Date();

  await storeMessageDirect({
    id: `routed-${now.getTime()}-${target.targetJid}`,
    chat_jid: target.targetJid,
    sender: msg.sender,
    sender_name: msg.sender_name,
    content: `${strippedPrompt || msg.content.trim()}\n\n[Routed from ${hubGroup.name}. Reply using send_message with target_jid: "${hubJid}"]`,
    timestamp: now.toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });

  enqueueMessageCheck(target.targetJid);

  logger.info(
    {
      callerJid: hubJid,
      targetJid: target.targetJid,
      trigger: target.targetGroup.trigger,
    },
    'Multi-agent router: routed message to sub-agent',
  );
}

// --- Unknown Mention Notifier ---

/**
 * Checks if a message has an @mention that doesn't match any registered group.
 * Returns the formatted notification text, or null if no notification needed.
 *
 * Caller handles sending the message (keeps this module channel-agnostic).
 */
export function getUnknownMentionNotice(
  msg: NewMessage,
  hubJid: string,
): string | null {
  if (msg.is_from_me) return null;
  if (findDelegationTarget(msg, hubJid) !== null) return null;

  const content = msg.content.trim();
  const match = content.match(/^(@\S+)/);
  if (!match) return null;

  return `${match[1]} is not a registered agent.`;
}
