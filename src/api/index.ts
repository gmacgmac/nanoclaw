import express, { type Express } from 'express';
import { API_PORT } from '../config.js';
import { logger } from '../logger.js';
import type { GroupQueue } from '../group-queue.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { refreshMcpCatalog } from './mcp-catalog.js';
import { generateOpenApiDocument } from './openapi.js';
import { mountRoutes } from './routes/index.js';

/**
 * Create and start the NanoClaw management API server.
 * Binds to 127.0.0.1 (localhost only). Set API_TOKEN for remote access auth.
 *
 * @param queue - The GroupQueue instance (needed by container routes)
 */
export function startApiServer(queue: GroupQueue): Express {
  // Refresh MCP catalog before routes mount so handlers reading
  // `mcp-catalog.json` see fresh data on the first request.
  refreshMcpCatalog();

  const app = express();

  app.use(express.json());
  app.use(authMiddleware);

  // OpenAPI spec endpoint
  app.get('/api/openapi.json', (_req, res) => {
    res.json(generateOpenApiDocument());
  });

  mountRoutes(app, queue);

  app.use(errorHandler);

  app.listen(API_PORT, '127.0.0.1', () => {
    logger.info({ port: API_PORT }, 'API server listening');
  });

  return app;
}
