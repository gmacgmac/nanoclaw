import { z } from 'zod';

export const NotifyRequestSchema = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe(
      'Target group JIDs, or ["*"] to broadcast to all registered groups.',
    ),
  message: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      'Notification text to send. Markdown supported (Telegram) or plain text (dashboard).',
    ),
});

export const NotifyResponseSchema = z.object({
  ok: z.boolean(),
  delivered: z
    .array(z.string())
    .describe('JIDs where message was sent successfully.'),
  failed: z
    .array(
      z.object({
        jid: z.string(),
        reason: z.string(),
      }),
    )
    .describe('JIDs where delivery failed, with reason.'),
});
