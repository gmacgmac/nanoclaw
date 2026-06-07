import { z } from 'zod';

export const AdditionalMountSchema = z.object({
  hostPath: z.string().describe(
    'Absolute path on host (supports ~ for home directory). Must be allowed by mount-allowlist.json.',
  ),
  containerPath: z.string().optional().describe(
    'Mount destination inside container. Defaults to /workspace/extra/{basename of hostPath} if omitted.',
  ),
  readonly: z.boolean().optional().describe(
    'Whether mount is read-only. Default: true for safety.',
  ),
});

export const SsrfConfigSchema = z.object({
  allowPrivateNetworks: z.boolean().optional().describe(
    'Allow requests to private/internal network ranges (10.x, 172.16.x, 192.168.x). Default: false.',
  ),
  additionalBlockedHosts: z.array(z.string()).optional().describe(
    'Extra hostnames/IPs to block beyond the default private ranges.',
  ),
  additionalAllowedHosts: z.array(z.string()).optional().describe(
    'Hostnames/IPs to explicitly allow even if they would otherwise be blocked.',
  ),
});

export const McpServerSchema = z.object({
  command: z.string().describe(
    'Command to spawn the MCP server (e.g. "npx", "node").',
  ),
  args: z.array(z.string()).optional().describe(
    'Arguments passed to the command.',
  ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Environment variables for the MCP server process. API keys are injected by the host — do not hardcode secrets here.',
    ),
});

export const ContainerConfigSchema = z.object({
  preset: z.string().optional().describe(
    'Primary model preset name (must match a key in model-presets.json). Determines model, endpoint, and context window for all agent runs. Required for container to spawn.',
  ),
  taskPreset: z.string().nullable().optional().describe(
    'Model preset for scheduled task runs. Defaults to the main "preset" if null/omitted. Use a cheaper model for automated tasks.',
  ),
  nudgePreset: z.string().nullable().optional().describe(
    'Model preset for nightly nudge (memory maintenance) runs. Defaults to the main "preset" if null/omitted.',
  ),
  timeout: z.number().int().positive().optional().describe(
    'Container timeout in milliseconds. Default: 1800000 (30 minutes). Max single agent turn duration.',
  ),
  skills: z.array(z.string()).optional().describe(
    'Per-group skill selection. undefined = all skills (backward compat), [] = no skills, ["x","y"] = only named skills.',
  ),
  systemPrompt: z.string().optional().describe(
    'Per-group system prompt appended to the agent. undefined = use group CLAUDE.md only.',
  ),
  mcpServers: z
    .record(z.string(), McpServerSchema)
    .optional()
    .describe(
      'Per-group MCP servers to spawn alongside the built-in nanoclaw server. Key is server name (e.g. "brave-search").',
    ),
  telegramBot: z.string().optional().describe(
    'Telegram bot instance name for this group. Maps to TELEGRAM_{NAME}_BOT_TOKEN in secrets.env. Omit to use the default bot.',
  ),
  injectionScanMode: z.enum(['off', 'warn', 'block']).optional().describe(
    'Prompt injection scanning mode for context files (CLAUDE.md, MEMORY.md). "off" = skip, "warn" = log but continue (default), "block" = abort on critical findings.',
  ),
  ssrfProtection: z
    .union([z.boolean(), SsrfConfigSchema])
    .optional()
    .describe(
      'SSRF protection for outbound web_fetch. true/undefined = enabled (default), false = disabled, object = custom host lists.',
    ),
  approvalMode: z.boolean().optional().describe(
    'Command approval mode for dangerous commands on write-mounted paths. true (default) = dangerous commands require user approval, false = Bash unrestricted.',
  ),
  approvalTimeout: z.number().int().min(10).max(600).optional().describe(
    'Seconds before an approval request auto-denies. Default: 120. Range: 10–600.',
  ),
  commandAllowlist: z.array(z.string()).optional().describe(
    'Regex patterns for permanently approved commands that skip the approval flow. Use sparingly.',
  ),
  allowedHostCommands: z.array(z.string()).optional().describe(
    'Host commands this group can use (e.g. ["model", "version"]). undefined/[] = no host commands allowed (secure default).',
  ),
  learningLoop: z
    .union([z.boolean(), z.literal('extract-only')])
    .optional()
    .describe(
      "Skill extraction during memory nudge. false (default) = disabled, true = extract + load skills, \"extract-only\" = extract but don't auto-load (review first).",
    ),
  deniedTools: z.array(z.string()).optional().describe(
    'Tool names denied for this group (subtracted from the system allowlist ceiling). undefined = deny nothing extra.',
  ),
  hooks: z.array(z.string()).optional().describe(
    'Ordered list of reminder hook keys (filenames in docs/hooks/) injected via UserPromptSubmit on live chat turns.',
  ),
  additionalMounts: z.array(AdditionalMountSchema).optional().describe(
    'Extra host directories to mount into the container. Validated against mount-allowlist.json for security.',
  ),
});

export type ContainerConfigInput = z.input<typeof ContainerConfigSchema>;
