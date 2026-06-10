import { z } from 'zod';

export const McpToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Tool name as registered via server.tool(...)'),
});

export const McpServerDescriptorSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Server name. Valid key for containerConfig.mcpServers (or the built-in "nanoclaw" IPC server).',
    ),
  source: z
    .enum(['ipc-builtin', 'opt-in'])
    .describe(
      'ipc-builtin = always-on nanoclaw IPC server; opt-in = wired via containerConfig.mcpServers',
    ),
  tools: z
    .array(McpToolSchema)
    .describe(
      'Tools registered by this server. Best-effort; empty array if source unparseable.',
    ),
});

export const McpCatalogSchema = z.object({
  generatedAt: z
    .string()
    .describe('ISO timestamp of catalog generation (startup time).'),
  servers: z.array(McpServerDescriptorSchema),
});

export const GroupMcpToolsResponseSchema = z.object({
  data: z.object({
    ceiling: z
      .array(z.string())
      .describe('Built-in tool names from tool-allowlist.json'),
    mcpAvailable: McpCatalogSchema.describe('Full MCP catalog'),
    denied: z
      .array(z.string())
      .describe(
        'Intersection of containerConfig.deniedTools with the union of ceiling + mcp tools. Surface typos here — entries not matching a known tool are omitted.',
      ),
  }),
});
