import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { z } from 'zod';

/**
 * MCP server catalog.
 *
 * Generated at API startup by `refreshMcpCatalog()` and consumed by
 * `GET /api/mcp/servers` and `GET /api/groups/{jid}/mcp-tools`. Lives on
 * disk at `mcp-catalog.json` in the repo root, mirroring the pattern of
 * `tool-allowlist.json`.
 *
 * NOT committed — regenerated on every API start. The file is small
 * (~3KB) and per-request `readFileSync` is fine.
 */

export const MCP_CATALOG_PATH = path.resolve(process.cwd(), 'mcp-catalog.json');

const McpToolSchema = z.object({ name: z.string().min(1) });
const McpServerDescriptorSchema = z.object({
  name: z.string().min(1),
  source: z.enum(['ipc-builtin', 'opt-in']),
  tools: z.array(McpToolSchema),
});
const McpCatalogSchema = z.object({
  generatedAt: z.string(),
  servers: z.array(McpServerDescriptorSchema),
});

export type McpTool = z.infer<typeof McpToolSchema>;
export type McpServerDescriptor = z.infer<typeof McpServerDescriptorSchema>;
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

const EPOCH = new Date(0).toISOString();
const EMPTY_CATALOG: McpCatalog = {
  generatedAt: EPOCH,
  servers: [],
};

/**
 * Regex to extract tool names from `server.tool(` calls. The tool name is
 * always the first argument (a string literal). Best-effort — a server whose
 * source cannot be parsed yields `tools: []` rather than failing startup.
 */
const TOOL_REGEX = /server\.tool\(\s*['"]([^'"]+)['"]/g;

/** Path to the always-on `nanoclaw` IPC server source. */
const IPC_SERVER_SRC = path.join(
  process.cwd(),
  'container',
  'agent-runner',
  'src',
  'ipc-mcp-stdio.ts',
);

/** Opt-in MCP server source roots. */
const OPT_IN_SERVER_ROOTS = [
  path.join(process.cwd(), 'container', 'mcp-servers'),
];

function extractToolNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(TOOL_REGEX)) {
    out.push(m[1]);
  }
  return out;
}

function readToolNamesFromFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const src = fs.readFileSync(filePath, 'utf-8');
  return extractToolNames(src);
}

function listOptInServers(): Array<{ name: string; indexPath: string }> {
  const out: Array<{ name: string; indexPath: string }> = [];
  for (const root of OPT_IN_SERVER_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const indexPath = path.join(root, entry, 'src', 'index.ts');
      if (fs.existsSync(indexPath)) {
        out.push({ name: entry, indexPath });
      }
    }
  }
  return out;
}

/**
 * Build the in-memory catalog by scanning the IPC server source and the
 * opt-in server source roots. Never throws — a parse failure on a single
 * server yields `tools: []` for that server so the API can still start.
 */
export function buildMcpCatalog(): McpCatalog {
  const servers: McpServerDescriptor[] = [];

  const ipcTools = readToolNamesFromFile(IPC_SERVER_SRC);
  servers.push({
    name: 'nanoclaw',
    source: 'ipc-builtin',
    tools: ipcTools.map((name) => ({ name })),
  });

  for (const { name, indexPath } of listOptInServers()) {
    const toolNames = readToolNamesFromFile(indexPath);
    servers.push({
      name,
      source: 'opt-in',
      tools: toolNames.map((n) => ({ name: n })),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    servers,
  };
}

/**
 * Scan MCP server sources and write the catalog to `mcp-catalog.json`.
 * Called once at `startApiServer` time, before routes mount. Errors are
 * logged and swallowed — startup must not fail because of catalog issues.
 */
export function refreshMcpCatalog(): void {
  try {
    const catalog = buildMcpCatalog();
    fs.writeFileSync(MCP_CATALOG_PATH, JSON.stringify(catalog, null, 2));
    logger.info(
      { servers: catalog.servers.length, path: MCP_CATALOG_PATH },
      'MCP catalog refreshed',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to refresh MCP catalog — discovery endpoints will return 503',
    );
  }
}

/**
 * Read the catalog from disk. Returns the empty catalog (with the epoch
 * sentinel `generatedAt`) if the file is missing or unreadable.
 */
export function readMcpCatalog(): McpCatalog {
  try {
    if (!fs.existsSync(MCP_CATALOG_PATH)) return EMPTY_CATALOG;
    const raw = fs.readFileSync(MCP_CATALOG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return McpCatalogSchema.parse(parsed);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read MCP catalog — returning empty',
    );
    return EMPTY_CATALOG;
  }
}

/** True iff the catalog file exists on disk. */
export function mcpCatalogExists(): boolean {
  try {
    return fs.existsSync(MCP_CATALOG_PATH);
  } catch {
    return false;
  }
}
