import { z } from 'zod';

export const ChatSchema = z.object({
  jid: z.string().describe('Chat JID (e.g. tg:12345, dashboard@internal)'),
  name: z.string().describe('Display name'),
  last_message_time: z.string().describe('ISO timestamp of last message'),
  channel: z
    .string()
    .nullable()
    .describe('Channel (telegram, discord, slack, internal, null)'),
  is_group: z
    .number()
    .nullable()
    .describe('1 = group, 0 = individual, null = unknown'),
});

export const CreateChatRequestSchema = z.object({
  jid: z.string().min(1).describe('Chat JID'),
  name: z.string().min(1).describe('Display name'),
  channel: z.string().optional().describe('Channel identifier'),
  isGroup: z.boolean().optional().describe('Whether this is a group chat'),
});

export const MessageSchema = z.object({
  id: z.string(),
  chat_jid: z.string(),
  sender: z.string(),
  sender_name: z.string(),
  content: z.string(),
  timestamp: z.string(),
  is_from_me: z.union([z.literal(1), z.literal(0)]).optional(),
});

export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
  since: z
    .string()
    .optional()
    .describe('ISO timestamp — return messages after this time'),
});
