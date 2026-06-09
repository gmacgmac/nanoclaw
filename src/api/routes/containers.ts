import { Router } from 'express';
import { z } from 'zod';

import { testConnection } from '../../db.js';
import type { GroupQueue } from '../../group-queue.js';
import { defineRoute } from '../lib/route-builder.js';
import { JidSchema } from '../schemas/index.js';

export function createContainerRoutes(queue: GroupQueue) {
  const router = Router();

  defineRoute(router, {
    method: 'get',
    path: '/api/containers',
    summary: 'Container queue status',
    description:
      'Returns the runtime state of all groups in the queue: active, idle-waiting, pending messages, pending tasks count, container name.',
    responses: {
      200: {
        description: 'Container status array',
        schema: z.object({
          data: z.array(
            z.object({
              jid: z.string(),
              active: z.boolean(),
              idleWaiting: z.boolean(),
              pendingMessages: z.boolean(),
              pendingTasks: z.number(),
              containerName: z.string().nullable(),
            }),
          ),
        }),
      },
    },
    handler: (_req, res) => {
      res.json({ data: queue.getStatus() });
    },
  });

  defineRoute(router, {
    method: 'post',
    path: '/api/containers/{jid}/stop',
    summary: 'Stop a running container',
    description:
      'Writes a close sentinel to the group IPC input directory, signalling the agent to wind down. No-op if no container is running. Equivalent to /shutdown host command.',
    request: { params: z.object({ jid: JidSchema }) },
    responses: {
      200: {
        description: 'Stop result',
        schema: z.object({ ok: z.boolean(), wasRunning: z.boolean() }),
      },
    },
    handler: (req, res) => {
      const wasRunning = queue.closeStdin(req.params.jid as string);
      res.json({ ok: true, wasRunning });
    },
  });

  return router;
}
