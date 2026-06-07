import type { Express } from 'express';

import type { GroupQueue } from '../../group-queue.js';
import adminRouter from './admin.js';
import { createContainerRoutes } from './containers.js';
import groupsRouter from './groups.js';
import { createHealthRoute } from './health.js';
import presetsRouter from './presets.js';
import sessionsRouter from './sessions.js';

export function mountRoutes(app: Express, queue: GroupQueue): void {
  app.use(groupsRouter);
  app.use(sessionsRouter);
  app.use(presetsRouter);
  app.use(createContainerRoutes(queue));
  app.use(adminRouter);
  app.use(createHealthRoute(queue));
}
