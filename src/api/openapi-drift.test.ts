import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import { generateOpenApiDocument } from './openapi.js';
import { mountRoutes } from './routes/index.js';

/**
 * OpenAPI drift test.
 *
 * Asserts that the set of routes actually served by Express is identical to
 * the set of paths documented in the generated OpenAPI doc. A path that is
 * served but undocumented (or documented but unserved) is drift.
 *
 * IMPORTANT — expected intermediate failures:
 *   While Wave 2 (BE_03..BE_07) is in progress, paths may be registered TWICE
 *   (once in src/api/openapi.ts, once via defineRoute in the route files).
 *   This test will fail in that window. That's expected — BE_08 (Wave 3)
 *   removes the legacy registrations, at which point this test should pass.
 *
 *   The deliberate failure message is the regression-guard signal during
 *   the migration: it lists exactly which routes drift in either direction.
 */

interface RouteEntry {
  method: string;
  path: string;
}

interface ExpressLayer {
  name?: string;
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
  handle?: {
    stack?: ExpressLayer[];
  };
}

/**
 * Walk an Express 5 router stack recursively and collect every (method, path)
 * tuple. Handles both top-level routes (have a `route` property) and
 * mounted sub-routers (have a `handle` that is itself a router).
 *
 * In the current codebase, each route file declares its OWN full path on
 * inner layers (e.g. `router.get('/api/groups', ...)`), and `mountRoutes`
 * uses `app.use(router)` with no mount prefix. So the path on the inner
 * `route` is already the full canonical path and no prefix concatenation
 * is needed.
 */
function collectExpressRoutes(stack: ExpressLayer[]): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.handle?.stack) {
      out.push(...collectExpressRoutes(layer.handle.stack));
    }
  }
  return out;
}

/**
 * Build the same Express app the production server uses, but without
 * starting a listener. Auth middleware is intentionally omitted — drift is
 * about path registration, not auth behavior.
 */
function buildApp(): Express {
  const app = express();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(generateOpenApiDocument());
  });
  // mountRoutes requires a GroupQueue; pass a minimal stub.
  const fakeQueue = {} as any;
  mountRoutes(app, fakeQueue);
  return app;
}

/**
 * Extract the set of (method, path) tuples from a generated OpenAPI 3.1
 * document, normalised to Express-style `:param` paths and uppercase methods.
 */
function collectOpenApiRoutes(doc: any): RouteEntry[] {
  const out: RouteEntry[] = [];
  const paths = doc?.paths ?? {};
  for (const [openapiPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const expressPath = openapiPath.replace(/\{(\w+)\}/g, ':$1');
    for (const method of Object.keys(pathItem)) {
      if (
        method === 'get' ||
        method === 'post' ||
        method === 'put' ||
        method === 'patch' ||
        method === 'delete' ||
        method === 'head' ||
        method === 'options'
      ) {
        out.push({ method: method.toUpperCase(), path: expressPath });
      }
    }
  }
  return out;
}

function diff(
  a: RouteEntry[],
  b: RouteEntry[],
): { onlyA: RouteEntry[]; onlyB: RouteEntry[] } {
  const key = (r: RouteEntry) => `${r.method} ${r.path}`;
  const aKeys = new Set(a.map(key));
  const bKeys = new Set(b.map(key));
  const split = (k: string): RouteEntry => {
    const [method, path] = k.split(' ');
    return { method, path };
  };
  return {
    onlyA: [...aKeys].filter((k) => !bKeys.has(k)).map(split),
    onlyB: [...bKeys].filter((k) => !aKeys.has(k)).map(split),
  };
}

function formatRoutes(rs: RouteEntry[]): string {
  if (rs.length === 0) return '  (none)';
  return rs.map((r) => `  ${r.method} ${r.path}`).join('\n');
}

describe('OpenAPI drift: served Express routes === documented OpenAPI paths', () => {
  it('every served route is documented, and every documented route is served', () => {
    const app = buildApp();
    // Express 5 renamed `_router` to `router` (Express 4 used `_router`).
    const expressStack =
      (app as any).router?.stack ?? (app as any)._router?.stack ?? [];
    const served = collectExpressRoutes(expressStack);

    const doc = generateOpenApiDocument();
    const documented = collectOpenApiRoutes(doc);

    // /api/openapi.json is the meta-endpoint (it serves the doc itself);
    // it is intentionally NOT registered via defineRoute and NOT in the
    // OpenAPI doc. Exclude it from both sides.
    const isMeta = (r: RouteEntry) =>
      r.method === 'GET' && r.path === '/api/openapi.json';
    const servedFiltered = served.filter((r) => !isMeta(r));
    const documentedFiltered = documented.filter((r) => !isMeta(r));

    const { onlyA: servedButUndocumented, onlyB: documentedButUnserved } = diff(
      servedFiltered,
      documentedFiltered,
    );

    const messages: string[] = [];
    if (servedButUndocumented.length > 0) {
      messages.push(
        `Routes served by Express but NOT documented in OpenAPI (${servedButUndocumented.length}):\n${formatRoutes(servedButUndocumented)}`,
      );
    }
    if (documentedButUnserved.length > 0) {
      messages.push(
        `Paths documented in OpenAPI but NOT served by Express (${documentedButUnserved.length}):\n${formatRoutes(documentedButUnserved)}`,
      );
    }
    if (messages.length > 0) {
      throw new Error('OpenAPI drift detected:\n\n' + messages.join('\n\n'));
    }

    expect(servedButUndocumented).toEqual([]);
    expect(documentedButUnserved).toEqual([]);
  });
});
