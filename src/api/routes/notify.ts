import { Router } from 'express';

import { getChannelList, getRegisteredGroups } from '../../group-registry.js';
import { logger } from '../../logger.js';
import { findChannel } from '../../router.js';
import {
  NotifyRequestSchema,
  NotifyResponseSchema,
} from '../schemas/notify.js';
import { defineRoute } from '../lib/route-builder.js';

const router = Router();

defineRoute(router, {
  method: 'post',
  path: '/api/notify',
  summary: 'Send a notification to group channel(s)',
  description:
    'Delivers a one-way notification message to one or more group channels without inserting into the messages table, spawning a container, or triggering an agent run. Use ["*"] to broadcast to all registered groups. Delivery is best-effort: failures (unknown JID, disconnected channel) are reported in the failed array; the endpoint still returns 200.',
  request: {
    body: NotifyRequestSchema,
  },
  responses: {
    200: {
      description: 'Delivery result',
      schema: NotifyResponseSchema,
    },
  },
  handler: async (req, res) => {
    const { targets, message } = req.body as {
      targets: string[];
      message: string;
    };

    const channels = getChannelList();
    const registeredGroups = getRegisteredGroups();

    const expandedTargets = targets.includes('*')
      ? Object.keys(registeredGroups)
      : targets;

    const delivered: string[] = [];
    const failed: { jid: string; reason: string }[] = [];

    for (const jid of expandedTargets) {
      if (!registeredGroups[jid]) {
        failed.push({ jid, reason: 'Group not found' });
        continue;
      }
      const channel = findChannel(channels, jid);
      if (!channel) {
        failed.push({ jid, reason: 'No channel owns JID' });
        continue;
      }
      if (!channel.isConnected()) {
        failed.push({ jid, reason: 'Channel disconnected' });
        continue;
      }
      try {
        await channel.sendMessage(jid, message);
        delivered.push(jid);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ jid, err }, 'Notify sendMessage failed');
        failed.push({ jid, reason: `Send failed: ${reason}` });
      }
    }

    res.json({ ok: failed.length === 0, delivered, failed });
  },
});

export default router;
