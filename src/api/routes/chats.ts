import { Router } from 'express';
import { z } from 'zod';

import {
  deleteMessagesForChat,
  getAllChats,
  getChatByJid,
  getMessagesSince,
  storeChatMetadata,
} from '../../db.js';
import type { Cursor } from '../../cursor-state.js';
import { defineRoute } from '../lib/route-builder.js';
import {
  ApiErrorSchema,
  ChatSchema,
  CreateChatRequestSchema,
  ListMessagesQuerySchema,
  MessageSchema,
} from '../schemas/index.js';

const router = Router();

const GROUP_SYNC_MARKER = '__group_sync__';

defineRoute(router, {
  method: 'get',
  path: '/api/chats',
  summary: 'List all chats',
  description:
    'Returns all known chat rows ordered by most recent activity. Excludes the internal __group_sync__ marker.',
  responses: {
    200: {
      description: 'Chat list',
      schema: z.object({ data: z.array(ChatSchema) }),
    },
  },
  handler: async (_req, res) => {
    const chats = await getAllChats();
    const data = chats.filter((c) => c.jid !== GROUP_SYNC_MARKER);
    res.json({ data });
  },
});

defineRoute(router, {
  method: 'post',
  path: '/api/chats',
  summary: 'Create or update a chat row',
  description:
    'Upserts a chat row. If the JID already exists, updates name/channel/isGroup and bumps last_message_time. Used by internal group setup workflows.',
  request: { body: CreateChatRequestSchema },
  responses: {
    200: {
      description: 'Chat upserted',
      schema: z.object({ data: ChatSchema }),
    },
  },
  handler: async (req, res) => {
    const { jid, name, channel, isGroup } = req.body;
    const now = new Date().toISOString();
    await storeChatMetadata(jid, now, name, channel, isGroup);
    const chat = await getChatByJid(jid);
    res.json({ data: chat });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/chats/{jid}',
  summary: 'Get a single chat',
  description: 'Returns one chat row by JID. 404 if not found.',
  request: { params: z.object({ jid: z.string() }) },
  responses: {
    200: {
      description: 'Chat found',
      schema: z.object({ data: ChatSchema }),
    },
    404: {
      description: 'Chat not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const jid = req.params.jid as string;
    const chat = await getChatByJid(jid);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.json({ data: chat });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/chats/{jid}/messages',
  summary: 'List messages for a chat',
  description:
    'Returns recent messages for a chat JID, paginated by timestamp. Default limit 50, max 200.',
  request: {
    params: z.object({ jid: z.string() }),
    query: ListMessagesQuerySchema,
  },
  responses: {
    200: {
      description: 'Message list',
      schema: z.object({ data: z.array(MessageSchema) }),
    },
  },
  handler: async (req, res) => {
    const jid = req.params.jid as string;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const since = typeof req.query.since === 'string' ? req.query.since : '';
    const sinceCursor: Cursor = { ts: since, id: '0' };
    const messages = await getMessagesSince(jid, sinceCursor, limit);
    res.json({ data: messages });
  },
});

defineRoute(router, {
  method: 'delete',
  path: '/api/chats/{jid}/messages',
  summary: 'Clear message history for a chat',
  description:
    'Deletes all messages for a chat JID. Requires ?confirm=true query parameter to prevent accidental destruction.',
  request: {
    params: z.object({ jid: z.string() }),
    query: z.object({ confirm: z.string() }),
  },
  responses: {
    200: {
      description: 'Messages cleared',
      schema: z.object({ ok: z.boolean(), deleted: z.number() }),
    },
    400: {
      description: 'Missing confirm param',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    if (req.query.confirm !== 'true') {
      res.status(400).json({
        error: 'Must pass ?confirm=true to delete messages',
      });
      return;
    }
    const jid = req.params.jid as string;
    const deleted = await deleteMessagesForChat(jid);
    res.json({ ok: true, deleted });
  },
});

export default router;
