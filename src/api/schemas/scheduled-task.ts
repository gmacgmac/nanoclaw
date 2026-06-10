import { z } from 'zod';

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  group_folder: z.string(),
  chat_jid: z.string(),
  prompt: z.string(),
  description: z.string().nullable().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string(),
  context_mode: z.enum(['group', 'isolated']),
  next_run: z.string().nullable(),
  last_run: z.string().nullable(),
  last_result: z.string().nullable(),
  status: z.enum(['active', 'paused', 'completed']),
  created_at: z.string(),
  script: z.string().nullable().optional(),
});

export const CreateTaskRequestSchema = z.object({
  id: z.string().min(1).describe('Unique task ID (caller-generated)'),
  group_folder: z.string().min(1),
  chat_jid: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string().min(1),
  context_mode: z.enum(['group', 'isolated']).default('isolated'),
  next_run: z.string().nullable().optional(),
  status: z.enum(['active', 'paused']).default('active'),
  script: z.string().optional(),
});

export const UpdateTaskRequestSchema = z.object({
  description: z.string().optional(),
  prompt: z.string().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  next_run: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
  script: z.string().nullable().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
});

export const ListTasksQuerySchema = z.object({
  groupFolder: z.string().optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
});
