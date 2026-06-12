import { z } from 'zod';

// JID format: "tg:<chatId>[:<botName>]" for Telegram or "<name>@internal" for dashboard.
// Deviations from plan: plan's regex `/^[a-zA-Z0-9._-]+@(telegram|internal)$/` does not
// match the actual production format. Telegram JIDs use `tg:` prefix and optional `:botName`
// suffix (see `makeJid` in src/channels/telegram.ts and any row with chat_jid `tg:<digits>`
// in store/messages.db). Dashboard JIDs use `@internal` suffix (see DashboardChannel.ownsJid).
export const JidSchema = z
  .string()
  .regex(/^(tg:[0-9]+(:[a-zA-Z0-9_-]+)?|[a-zA-Z0-9._-]+@internal)$/)
  .describe(
    'Group identifier. Format: "tg:<chat_id>[:<bot_name>]" for Telegram groups or "<name>@internal" for dashboard groups. Telegram bot_name suffix selects a non-default bot.',
  );

// Group folder: alphanumeric + hyphens, no path traversal
export const FolderSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .min(1)
  .max(64)
  .describe(
    'Group folder name. Alphanumeric with hyphens/underscores, no path traversal. Used as the directory name under groups/.',
  );

// Container channel
export const ContainerChannelSchema = z
  .enum(['stable', 'next'])
  .describe(
    'Container image channel. "stable" = production image, "next" = latest dev image. Default: "stable".',
  );

// Standard API error response
export const ApiErrorSchema = z.object({
  error: z.string().describe('Human-readable error message'),
  code: z
    .string()
    .optional()
    .describe(
      'Machine-readable error code (e.g. "NOT_FOUND", "VALIDATION_ERROR")',
    ),
});
