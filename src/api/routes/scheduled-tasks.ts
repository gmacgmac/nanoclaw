import { Router } from 'express';
import { z } from 'zod';

import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  getTasksForGroup,
  updateTask,
} from '../../db.js';
import { defineRoute } from '../lib/route-builder.js';
import {
  ApiErrorSchema,
  CreateTaskRequestSchema,
  ListTasksQuerySchema,
  ScheduledTaskSchema,
  UpdateTaskRequestSchema,
} from '../schemas/index.js';

const router = Router();

defineRoute(router, {
  method: 'get',
  path: '/api/scheduled-tasks',
  summary: 'List scheduled tasks',
  description:
    'Returns all scheduled tasks, optionally filtered by groupFolder and/or status.',
  request: { query: ListTasksQuerySchema },
  responses: {
    200: {
      description: 'Task list',
      schema: z.object({ data: z.array(ScheduledTaskSchema) }),
    },
  },
  handler: async (req, res) => {
    const { groupFolder, status } = req.query as {
      groupFolder?: string;
      status?: string;
    };
    let tasks = groupFolder
      ? await getTasksForGroup(groupFolder)
      : await getAllTasks();
    if (status) tasks = tasks.filter((t) => t.status === status);
    res.json({ data: tasks });
  },
});

defineRoute(router, {
  method: 'get',
  path: '/api/scheduled-tasks/{id}',
  summary: 'Get a scheduled task by ID',
  description: 'Returns one task. 404 if not found.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Task found',
      schema: z.object({ data: ScheduledTaskSchema }),
    },
    404: {
      description: 'Task not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ data: task });
  },
});

defineRoute(router, {
  method: 'post',
  path: '/api/scheduled-tasks',
  summary: 'Create a scheduled task',
  description:
    'Creates a new scheduled task. The caller provides the task ID. Returns the created task.',
  request: { body: CreateTaskRequestSchema },
  responses: {
    201: {
      description: 'Task created',
      schema: z.object({ data: ScheduledTaskSchema }),
    },
    409: {
      description: 'Task ID already exists',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const body = req.body as z.infer<typeof CreateTaskRequestSchema>;
    const existing = await getTaskById(body.id);
    if (existing) {
      res
        .status(409)
        .json({ error: `Task '${body.id}' already exists`, code: 'CONFLICT' });
      return;
    }
    const task = {
      ...body,
      next_run: body.next_run ?? null,
      status: body.status ?? 'active',
      context_mode: body.context_mode ?? 'isolated',
      created_at: new Date().toISOString(),
    };
    await createTask(task);
    const created = await getTaskById(body.id);
    res.status(201).json({ data: created });
  },
});

defineRoute(router, {
  method: 'patch',
  path: '/api/scheduled-tasks/{id}',
  summary: 'Update a scheduled task',
  description:
    'Partial update of task metadata. Does not reschedule — next_run changes take effect on next scheduler tick.',
  request: {
    params: z.object({ id: z.string() }),
    body: UpdateTaskRequestSchema,
  },
  responses: {
    200: {
      description: 'Task updated',
      schema: z.object({ data: ScheduledTaskSchema }),
    },
    404: {
      description: 'Task not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const id = req.params.id as string;
    const task = await getTaskById(id);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
      return;
    }
    await updateTask(id, req.body);
    const updated = await getTaskById(id);
    res.json({ data: updated });
  },
});

defineRoute(router, {
  method: 'delete',
  path: '/api/scheduled-tasks/{id}',
  summary: 'Delete a scheduled task',
  description:
    'Permanently deletes a task and its run logs (cascade). Cannot be undone.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Task deleted',
      schema: z.object({ ok: z.boolean() }),
    },
    404: {
      description: 'Task not found',
      schema: ApiErrorSchema,
    },
  },
  handler: async (req, res) => {
    const id = req.params.id as string;
    const task = await getTaskById(id);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'NOT_FOUND' });
      return;
    }
    await deleteTask(id);
    res.json({ ok: true });
  },
});

export default router;
