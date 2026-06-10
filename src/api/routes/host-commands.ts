import { Router } from 'express';

import { defineRoute } from '../lib/route-builder.js';
import { HostCommandsResponseSchema } from '../schemas/index.js';

const router = Router();

/**
 * Valid gated host commands — must match the dispatch in
 * `repo/src/host-commands.ts` `handleHostCommand`. Ungated commands
 * (`shutdown`, `stop`, `context`, `newsession`) are always available
 * to any group and are NOT candidates for `allowedHostCommands`.
 */
const GATED_COMMANDS = [
  {
    name: 'model',
    description: 'Switch model preset (requires container restart)',
  },
  {
    name: 'version',
    description: 'Switch container image channel (stable/next)',
  },
] as const;

const UNGATED_COMMANDS = [
  {
    name: 'shutdown',
    description: 'Stop container, next message re-spawns',
  },
  {
    name: 'stop',
    description: 'Stop container, next message continues session',
  },
  {
    name: 'context',
    description: 'Show context window usage',
  },
  {
    name: 'newsession',
    description: 'Start a fresh session (clears conversation history)',
  },
] as const;

defineRoute(router, {
  method: 'get',
  path: '/api/host-commands',
  summary: 'Valid host commands for groups',
  description:
    'Returns the canonical list of host commands, split into commands ' +
    'that require the group to opt in via `containerConfig.allowedHostCommands` ' +
    '(gated) and commands that are always available (ungated). Use this ' +
    'to validate a `PATCH /api/groups/{jid}/allowed-host-commands` body.',
  responses: {
    200: {
      description: 'Host command catalog',
      schema: HostCommandsResponseSchema,
    },
  },
  handler: (_req, res) => {
    res.json({
      data: { gated: [...GATED_COMMANDS], ungated: [...UNGATED_COMMANDS] },
    });
  },
});

export const GATED_HOST_COMMANDS = GATED_COMMANDS.map((c) => c.name);
export const UNGATED_HOST_COMMANDS = UNGATED_COMMANDS.map((c) => c.name);

export default router;
