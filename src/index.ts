import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  NUDGE_INTERVAL,
  POLL_INTERVAL,
  SHUTDOWN_GRACE_MS,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
} from './container-runner.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  setSession,
  deleteSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  getGlobalCursor,
  getGroupCursor,
  getOrRecoverGroupCursor,
  loadCursors,
  rollbackGroupCursor,
  setGlobalCursor,
  setGroupCursor,
} from './cursor-state.js';
import { GroupQueue } from './group-queue.js';
import {
  getAvailableGroups,
  getRegisteredGroup,
  getRegisteredGroups,
  registerGroup,
  setChannelList,
  setRegisteredGroups,
  updateRegisteredGroup,
} from './group-registry.js';
import { checkApprovalResponse, startIpcWatcher } from './ipc.js';
import { getNightlyNudgePrompt } from './lib/nudge-prompt.js';
import { runInjectionScan } from './lib/injection-scan-flow.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  startNightlyCron,
  startSchedulerLoop,
  stopSchedulerLoop,
} from './task-scheduler.js';
import { sweepAbandonedRuns } from './abandoned-run-sweep.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { handleHostCommand } from './host-commands.js';
import {
  delegateMessage,
  findDelegationTarget,
  getUnknownMentionNotice,
  isHubMessage,
} from './multi-agent-router.js';
import { runPresetMigration } from './migrations/001-preset-migration.js';
import { runDeniedToolsMigration } from './migrations/002-deniedtools-migration.js';
import {
  getAvailablePresetNames,
  loadPresets,
  PRESETS_PATH,
  resolvePreset,
} from './presets.js';
import { EncodedImage } from './image.js';
import { extractImagesFromMessages } from './lib/image-extraction.js';
import { resolveSpawnConfig } from './spawn-config.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';
export { updateRegisteredGroup, getAvailableGroups } from './group-registry.js';
export { setRegisteredGroups as _setRegisteredGroups } from './group-registry.js';

let sessions: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  loadCursors();
  sessions = getAllSessions();
  setRegisteredGroups(getAllRegisteredGroups());
  const channelCounts = Object.values(getRegisteredGroups()).reduce(
    (acc, g) => {
      const ch = g.containerChannel ?? 'stable';
      acc[ch] = (acc[ch] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  logger.info(
    { groupCount: Object.keys(getRegisteredGroups()).length, channelCounts },
    'State loaded',
  );
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = getRegisteredGroup(chatJid);
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverGroupCursor(chatJid),
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Multi-agent router: if this hub group has multiAgentRouter enabled,
  // filter out messages that match sub-agent triggers. These should have
  // been delegated by startMessageLoop already — this prevents re-processing
  // if processGroupMessages is called via enqueueMessageCheck or recovery.
  let filteredMessages = missedMessages;
  if (group.multiAgentRouter && isMainGroup) {
    filteredMessages = missedMessages.filter((msg) =>
      isHubMessage(msg, chatJid),
    );
    if (filteredMessages.length === 0) {
      // All messages were for sub-agents — advance cursor and skip
      setGroupCursor(
        chatJid,
        missedMessages[missedMessages.length - 1].timestamp,
      );
      return true;
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(filteredMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = getGroupCursor(chatJid) || '';
  setGroupCursor(chatJid, missedMessages[missedMessages.length - 1].timestamp);

  logger.info(
    { group: group.name, messageCount: filteredMessages.length },
    'Processing messages',
  );

  // Validate preset before spawning container
  const resolved = resolvePreset(group.containerConfig?.preset);
  if (!resolved) {
    const presets = loadPresets();
    const available = getAvailablePresetNames();
    let errorMsg: string;

    if (Object.keys(presets).length === 0) {
      errorMsg = `❌ No model presets configured.\n\nEdit \`${PRESETS_PATH}\` to define model presets, then use /model to select one.`;
    } else if (!group.containerConfig?.preset) {
      errorMsg = `❌ No model preset assigned to this group.\n\nAvailable presets: ${available.map((n) => `\`${n}\``).join(', ')}\n\nUse /model <name> to select one.`;
    } else {
      errorMsg = `❌ Preset \`${group.containerConfig.preset}\` not found.\n\nAvailable presets: ${available.map((n) => `\`${n}\``).join(', ')}\n\nUse /model <name> to switch.`;
    }

    logger.warn(
      { group: group.name, preset: group.containerConfig?.preset },
      'Preset resolution failed, container not spawned',
    );
    await channel.sendMessage(chatJid, errorMsg);

    // Roll back cursor so messages remain pending for retry after user fixes preset
    rollbackGroupCursor(chatJid, previousCursor);
    return true; // consumed from queue perspective — don't retry-spam
  }

  // Extract images from messages if vision is supported
  let images: EncodedImage[] = [];

  if (resolved.capabilities.vision) {
    const result = await extractImagesFromMessages(filteredMessages);
    images = result.images;
    if (result.truncated) {
      logger.warn(
        { group: group.name, imageCount: images.length },
        'Image payload size limit reached, truncating',
      );
    }
    if (images.length > 0) {
      logger.info(
        {
          group: group.name,
          imageCount: images.length,
          totalSize: result.totalSize,
        },
        'Encoded images for vision',
      );
    }
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    images,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    rollbackGroupCursor(chatJid, previousCursor);
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  images: EncodedImage[],
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  // --- Per-spawn config resolution (single chokepoint) ---
  const spawnConfig = resolveSpawnConfig(chatJid);
  if (!spawnConfig) {
    logger.error({ chatJid }, 'resolveSpawnConfig returned null — group gone');
    return 'error';
  }

  const {
    group: freshGroup,
    containerConfig,
    preset,
    effectiveAllowedTools,
  } = spawnConfig;
  const isMain = freshGroup.isMain === true;
  const isAdmin = freshGroup.isAdmin === true;
  const sessionId = sessions[freshGroup.folder];

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  const registeredGroupsList = Object.entries(getRegisteredGroups()).map(
    ([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      isMain: g.isMain === true,
    }),
  );
  writeGroupsSnapshot(
    freshGroup.folder,
    isMain,
    availableGroups,
    registeredGroupsList,
  );

  // Wrap onOutput to track session ID from streamed results.
  // Note: post-exit actions in the queue (e.g. /newsession clearSessionState) run AFTER
  // runAgent returns, so the order guarantees correctness for session clearing.
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[freshGroup.folder] = output.newSessionId;
          setSession(freshGroup.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    // --- Prompt injection scanning (BE_04) ---
    const scanMode = containerConfig.injectionScanMode ?? 'warn';

    // Resolve extra-mount host paths for scanning (same validation as buildVolumeMounts)
    let additionalMountPaths: string[] | undefined;
    if (freshGroup.containerConfig?.additionalMounts?.length) {
      const validated = validateAdditionalMounts(
        freshGroup.containerConfig.additionalMounts,
        freshGroup.name,
        isMain,
      );
      if (validated.length > 0) {
        additionalMountPaths = validated.map((m) => m.hostPath);
      }
    }

    const { proceed } = await runInjectionScan({
      group: freshGroup,
      chatJid,
      scanMode,
      additionalMountPaths,
    });
    if (!proceed) return 'error';

    // Debug: log allowedTools being passed to container
    if (effectiveAllowedTools) {
      logger.info(
        { group: freshGroup.name, allowedTools: effectiveAllowedTools },
        'Passing allowedTools to container',
      );
    }

    if (!preset) {
      logger.warn(
        { group: freshGroup.name, preset: freshGroup.containerConfig?.preset },
        'Preset resolution failed, container not spawned',
      );
      return 'error';
    }

    const output = await runContainerAgent(
      freshGroup,
      {
        prompt,
        sessionId,
        groupFolder: freshGroup.folder,
        chatJid,
        isMain,
        isAdmin,
        assistantName: ASSISTANT_NAME,
        // Agent customisation from containerConfig
        allowedTools: effectiveAllowedTools,
        model: preset.model,
        systemPrompt: containerConfig.systemPrompt,
        mcpServers: containerConfig.mcpServers,
        endpoint: preset.endpoint,
        webSearchVendor: preset.webSearchVendor,
        contextWindowSize: preset.contextWindow,
        learningLoop: containerConfig.learningLoop,
        approvalTimeout: containerConfig.approvalTimeout,
        commandAllowlist: containerConfig.commandAllowlist,
        nudgeInterval: NUDGE_INTERVAL,
        images: images.length > 0 ? images : undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, freshGroup.folder),
      wrappedOnOutput,
    );

    // Track session ID from final output.
    // Post-exit actions in the queue drain AFTER this function returns,
    // so /newsession's clearSessionState correctly overwrites this write.
    if (output.newSessionId) {
      sessions[freshGroup.folder] = output.newSessionId;
      setSession(freshGroup.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: freshGroup.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(getRegisteredGroups());
      const { messages, newTimestamp } = getNewMessages(
        jids,
        getGlobalCursor(),
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        setGlobalCursor(newTimestamp);

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = getRegisteredGroup(chatJid);
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // Multi-agent router: if this group has multiAgentRouter enabled,
          // scan messages for other groups' trigger patterns and delegate
          // those messages instead of processing them locally.
          if (group.multiAgentRouter && isMainGroup) {
            const allowlistCfg = loadSenderAllowlist();
            for (const msg of groupMessages) {
              if (msg.is_from_me) continue;
              if (!isTriggerAllowed(chatJid, msg.sender, allowlistCfg))
                continue;

              const target = findDelegationTarget(msg, chatJid);
              if (target) {
                delegateMessage({
                  hubGroup: group,
                  hubJid: chatJid,
                  msg,
                  target,
                  enqueueMessageCheck: (jid) => queue.enqueueMessageCheck(jid),
                });
              } else {
                const notice = getUnknownMentionNotice(msg, chatJid);
                if (notice) {
                  await channel.sendMessage(chatJid, notice).catch(() => {});
                }
              }
            }

            // After routing, filter out any delegated messages so the hub
            // agent only sees messages that weren't claimed by a sub-agent
            const unclaimedMessages = groupMessages.filter((msg) =>
              isHubMessage(msg, chatJid),
            );
            if (unclaimedMessages.length === 0) {
              // All messages were delegated — advance the hub's cursor past them
              // so processGroupMessages won't re-fetch and re-process them.
              const lastMsg = groupMessages[groupMessages.length - 1];
              setGroupCursor(chatJid, lastMsg.timestamp);
              continue;
            }
          }

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since group cursor so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverGroupCursor(chatJid),
            MAX_MESSAGES_PER_PROMPT,
          );

          // If nothing pending, the cursor has advanced past all "new" messages
          // (e.g., processed by enqueueMessageCheck for routed messages). Don't
          // re-process groupMessages - that would double-send to the container.
          if (allPending.length === 0) {
            // Advance global cursor past these messages to prevent re-seeing them
            for (const msg of groupMessages) {
              if (msg.timestamp > getGlobalCursor()) {
                setGlobalCursor(msg.timestamp);
              }
            }
            continue;
          }

          let messagesToSend = allPending;

          // If multiAgentRouter is active, filter out delegated messages from
          // the DB re-fetch so the hub agent doesn't see them.
          if (group.multiAgentRouter && isMainGroup) {
            messagesToSend = messagesToSend.filter((msg) =>
              isHubMessage(msg, chatJid),
            );
            if (messagesToSend.length === 0) continue;
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Extract images for piped messages if vision is supported
          let pipedImages: EncodedImage[] | undefined;
          const resolved = resolvePreset(group.containerConfig?.preset);
          if (resolved?.capabilities.vision) {
            const result = await extractImagesFromMessages(messagesToSend);
            if (result.images.length > 0) {
              pipedImages = result.images;
              logger.debug(
                { chatJid, imageCount: result.images.length },
                'Encoded images for piped IPC message',
              );
            }
          }

          if (queue.sendMessage(chatJid, formatted, pipedImages)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            setGroupCursor(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing global cursor and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(getRegisteredGroups())) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverGroupCursor(chatJid),
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  runPresetMigration();
  runDeniedToolsMigration();
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      // Second signal — hard exit immediately
      logger.warn(
        { signal },
        'Second signal received — forcing immediate exit',
      );
      process.exit(1);
    }
    isShuttingDown = true;
    logger.info(
      { signal, gracePeriodMs: SHUTDOWN_GRACE_MS },
      'Shutdown signal received',
    );
    stopSchedulerLoop();
    proxyServer.close();
    await queue.shutdown(SHUTDOWN_GRACE_MS);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = getRegisteredGroup(chatJid);
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Command approval response — intercept yes/no replies before storage
      if (!msg.is_from_me && !msg.is_bot_message) {
        const sendFn = async (jid: string, text: string) => {
          const ch = findChannel(channels, jid);
          if (ch?.isConnected()) await ch.sendMessage(jid, text);
        };
        if (checkApprovalResponse(chatJid, msg.content, sendFn)) {
          return; // Consumed by approval flow — do not forward to agent
        }
      }

      // Host commands — intercept before storage (ungated commands like /shutdown
      // must be reachable even without allowedHostCommands configured)
      const group = getRegisteredGroup(chatJid);
      if (group && msg.content.trim().startsWith('/')) {
        const sendReply = async (text: string) => {
          const ch = findChannel(channels, chatJid);
          if (ch?.isConnected()) await ch.sendMessage(chatJid, text);
        };
        const clearSessionState = (groupFolder: string) => {
          delete sessions[groupFolder];
          deleteSession(groupFolder);
        };
        if (
          await handleHostCommand(
            msg,
            {
              jid: chatJid,
              group,
              sender: msg.sender,
              reply: sendReply,
            },
            queue.closeStdin.bind(queue),
            queue.onAfterExit.bind(queue),
            clearSessionState,
            updateRegisteredGroup,
          )
        ) {
          return;
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        getRegisteredGroup(chatJid)
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: getRegisteredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  setChannelList(channels);

  // Sweep orphaned task runs from previous crash (before scheduler starts)
  await sweepAbandonedRuns({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send sweep alert');
        return;
      }
      await channel.sendMessage(jid, text);
    },
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: getRegisteredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startNightlyCron(
    {
      runNudge: (group, chatJid) => {
        // Route nightly nudge through the queue so the container gets proper
        // lifecycle management (concurrency limiting, one-container-at-a-time).
        // Same pattern as scheduled tasks. No session deletion after nudge.
        return new Promise<boolean>((resolve) => {
          const taskId = `nightly-nudge-${group.folder}-${Date.now()}`;
          queue.enqueueTask(chatJid, taskId, async () => {
            try {
              // --- Per-spawn config resolution (single chokepoint) ---
              const spawnConfig = resolveSpawnConfig(chatJid);
              if (!spawnConfig || !spawnConfig.preset) {
                logger.warn(
                  { group: group.name, chatJid },
                  'resolveSpawnConfig failed or preset missing, nightly nudge skipped',
                );
                resolve(false);
                return;
              }

              const {
                group: freshGroup,
                containerConfig,
                preset,
                effectiveAllowedTools,
              } = spawnConfig;

              const output = await runContainerAgent(
                freshGroup,
                {
                  prompt: getNightlyNudgePrompt(containerConfig.learningLoop),
                  sessionId: sessions[freshGroup.folder],
                  groupFolder: freshGroup.folder,
                  chatJid,
                  isMain: freshGroup.isMain === true,
                  isAdmin: freshGroup.isAdmin === true,
                  assistantName: ASSISTANT_NAME,
                  allowedTools: effectiveAllowedTools,
                  model: preset.model,
                  systemPrompt: containerConfig.systemPrompt,
                  mcpServers: containerConfig.mcpServers,
                  endpoint: preset.endpoint,
                  webSearchVendor: preset.webSearchVendor,
                  contextWindowSize: preset.contextWindow,
                  learningLoop: containerConfig.learningLoop,
                  nudgeInterval: 0,
                },
                (proc, containerName) =>
                  queue.registerProcess(
                    chatJid,
                    proc,
                    containerName,
                    freshGroup.folder,
                  ),
                async (streamedOutput: ContainerOutput) => {
                  // Track session ID from streamed results.
                  // Post-exit actions in the queue guarantee /newsession correctness.
                  if (streamedOutput.newSessionId) {
                    sessions[freshGroup.folder] = streamedOutput.newSessionId;
                    setSession(freshGroup.folder, streamedOutput.newSessionId);
                  }
                },
              );

              if (output.status === 'error') {
                logger.error(
                  { group: freshGroup.name, error: output.error },
                  'Nightly nudge container error',
                );
                resolve(false);
              } else {
                resolve(true);
              }
            } catch (err) {
              logger.error({ group: group.name, err }, 'Nightly nudge failed');
              resolve(false);
            }
          });
        });
      },
    },
    '0 0 * * *',
  );
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendAttachment: async (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendAttachment)
        throw new Error(`Channel ${channel.name} does not support attachments`);
      await channel.sendAttachment(jid, filePath, caption);
    },
    registeredGroups: getRegisteredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      // Snapshot writes removed (BE_03) — will be replaced by request/response IPC in BE_05
    },
    enqueueMessageCheck: (jid: string) => queue.enqueueMessageCheck(jid),
    queue,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
