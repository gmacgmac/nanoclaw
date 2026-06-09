import { Router } from 'express';
import { z } from 'zod';

import { testConnection } from '../../db.js';
import type { GroupQueue } from '../../group-queue.js';
import { defineRoute } from '../lib/route-builder.js';

export function createHealthRoute(queue: GroupQueue) {
  const router = Router();
  const startTime = Date.now();

  defineRoute(router, {
    method: 'get',
    path: '/api/health',
    summary: 'Health check',
    description:
      'Returns process uptime in seconds, PostgreSQL connectivity boolean, and count of active containers.',
    responses: {
      200: {
        description: 'Health status',
        schema: z.object({
          status: z.string(),
          uptime: z.number(),
          db: z.boolean(),
          queueDepth: z.number(),
        }),
      },
    },
    handler: async (_req, res) => {
      let dbOk = false;
      try {
        dbOk = await testConnection();
      } catch {
        dbOk = false;
      }

      const status = queue.getStatus();
      const activeCount = status.filter((s) => s.active).length;

      res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        db: dbOk,
        queueDepth: activeCount,
      });
    },
  });

  return router;
}
