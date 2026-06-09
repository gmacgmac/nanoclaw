import type { Router, RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { registry } from '../openapi.js';
import { validateBody } from '../middleware/validate.js';

export interface RouteResponse {
  description: string;
  schema: ZodTypeAny;
}

export interface RouteDef {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  description?: string;
  request?: {
    params?: z.ZodObject<any>;
    query?: z.ZodObject<any>;
    body?: ZodTypeAny;
  };
  responses: Record<number, RouteResponse>;
  handler: RequestHandler;
}

export const registeredRoutes: Array<{ method: string; path: string }> = [];

export function defineRoute(router: Router, def: RouteDef): void {
  registry.registerPath({
    method: def.method,
    path: def.path,
    summary: def.summary,
    description: def.description,
    request: {
      ...(def.request?.params ? { params: def.request.params } : {}),
      ...(def.request?.query ? { query: def.request.query } : {}),
      ...(def.request?.body
        ? { body: { content: { 'application/json': { schema: def.request.body } } } }
        : {}),
    },
    responses: Object.fromEntries(
      Object.entries(def.responses).map(([code, r]) => [
        code,
        { description: r.description, content: { 'application/json': { schema: r.schema } } },
      ]),
    ),
  });

  const expressPath = def.path.replace(/\{(\w+)\}/g, ':$1');
  const handlers: RequestHandler[] = [];
  if (def.request?.body) handlers.push(validateBody(def.request.body));
  handlers.push(def.handler);
  router[def.method](expressPath, ...handlers);

  registeredRoutes.push({ method: def.method.toUpperCase(), path: expressPath });
}
