import { Router } from 'express';
import { z } from 'zod';

import { getRegisteredGroup } from '../../group-registry.js';
import { loadToolAllowlist } from '../../config.js';
import { readMcpCatalog } from '../mcp-catalog.js';
import { defineRoute } from '../lib/route-builder.js';
import {
  ApiErrorSchema,
  GroupMcpToolsResponseSchema,
  JidSchema,
} from '../schemas/index.js';

const router = Router();

defineRoute(router, {
  method: 'get',
  path: '/api/groups/{jid}/mcp-tools',
  summary: 'Effective MCP and built-in toolset for a group',
  description:
    'Returns the per-group view of available tools: the built-in ceiling ' +
    '(from `tool-allowlist.json`), the full MCP catalog, and the ' +
    'intersection of `containerConfig.deniedTools` with the union of ' +
    "ceiling + MCP tool names. Use this to validate that a group's deny " +
    'list only contains real tool names — typos are silently dropped ' +
    'from the `denied` response array.\n\n' +
    'Note: `repo/container/agent-runner/src/index.ts` hard-codes ' +
    "`mcp__nanoclaw__*` into the agent's `allowedTools` regardless of " +
    '`deniedTools`. The concrete-name deny in `options.tools` is the ' +
    'effective gate; the wildcard is defence-in-depth, not a leak. ' +
    'Future hardening: drop the wildcard in favour of the 15 concrete ' +
    'tool names from the catalog.',
  request: { params: z.object({ jid: JidSchema }) },
  responses: {
    200: {
      description: 'Effective toolset for the group',
      schema: GroupMcpToolsResponseSchema,
    },
    404: { description: 'Group not found', schema: ApiErrorSchema },
  },
  handler: (req, res) => {
    const jid = req.params.jid as string;
    const group = getRegisteredGroup(jid);
    if (!group) {
      res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
      return;
    }

    const ceiling = loadToolAllowlist();
    const mcpAvailable = readMcpCatalog();

    const known = new Set<string>(ceiling);
    for (const server of mcpAvailable.servers) {
      for (const tool of server.tools) {
        known.add(tool.name);
      }
    }

    const deniedRaw =
      (group.containerConfig?.deniedTools as unknown as unknown[]) ?? [];
    const denied = deniedRaw
      .filter((v): v is string => typeof v === 'string')
      .filter((name) => known.has(name));

    res.json({
      data: { ceiling, mcpAvailable, denied },
    });
  },
});

export default router;
