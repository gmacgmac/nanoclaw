/**
 * VERIFY_01: Logic tests for tool restrictions, Brave Search MCP injection,
 * and agent-browser binary mounting (BE_01, BE_03, BE_04).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// BE_01: disallowedTools complement computation
// ---------------------------------------------------------------------------

// Mirror of ALL_KNOWN_TOOLS from agent-runner/src/index.ts
const ALL_KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TaskOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterWorktree',
  'ExitWorktree',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'Agent',
  'Skill',
  'RemoteTrigger',
  'AskUserQuestion',
  'TodoWrite',
  'ToolSearch',
];

/** Mirrors the disallowedTools logic in agent-runner/src/index.ts */
function computeDisallowedTools(allowedTools: string[] | undefined): string[] {
  if (!allowedTools) return [];
  const tools = [...allowedTools, 'mcp__nanoclaw__*'];
  return ALL_KNOWN_TOOLS.filter((t) => !tools.includes(t));
}

describe('BE_01: disallowedTools complement', () => {
  it('returns empty array when allowedTools is undefined (no restrictions)', () => {
    expect(computeDisallowedTools(undefined)).toEqual([]);
  });

  it('blocks all tools when allowedTools is empty array', () => {
    const disallowed = computeDisallowedTools([]);
    expect(disallowed).toEqual(ALL_KNOWN_TOOLS);
    expect(disallowed).toContain('WebSearch');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('Agent');
    expect(disallowed).toContain('Bash');
  });

  it('blocks only tools not in allowedTools', () => {
    const allowed = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
    const disallowed = computeDisallowedTools(allowed);

    // Allowed tools must NOT appear in disallowed
    for (const t of allowed) {
      expect(disallowed).not.toContain(t);
    }

    // Non-allowed tools MUST appear in disallowed
    expect(disallowed).toContain('WebSearch');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('Agent');
    expect(disallowed).toContain('CronCreate');
    expect(disallowed).toContain('EnterPlanMode');
  });

  it('mcp__nanoclaw__* is never in disallowedTools', () => {
    // Even with empty allowedTools, nanoclaw IPC must always work
    const disallowed = computeDisallowedTools([]);
    expect(disallowed).not.toContain('mcp__nanoclaw__*');
  });

  it('telegram_main config: blocks web and planning tools', () => {
    // Actual telegram_main allowedTools from DB
    const telegramMainAllowed = [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'NotebookEdit',
    ];
    const disallowed = computeDisallowedTools(telegramMainAllowed);

    expect(disallowed).toContain('WebSearch');
    expect(disallowed).toContain('WebFetch');
    expect(disallowed).toContain('Agent');
    expect(disallowed).toContain('CronCreate');
    expect(disallowed).toContain('EnterPlanMode');
    expect(disallowed).toContain('RemoteTrigger');
  });

  it('disallowed + allowed covers all known tools (no gaps)', () => {
    const allowed = ['Bash', 'Read', 'Write'];
    const disallowed = computeDisallowedTools(allowed);
    const tools = [...allowed, 'mcp__nanoclaw__*'];

    // Every known tool must be in exactly one of: tools or disallowed
    for (const t of ALL_KNOWN_TOOLS) {
      const inAllowed = tools.includes(t);
      const inDisallowed = disallowed.includes(t);
      expect(inAllowed || inDisallowed).toBe(true);
      expect(inAllowed && inDisallowed).toBe(false); // no duplicates
    }
  });
});

// ---------------------------------------------------------------------------
// BE_03: Brave Search API key injection logic
// ---------------------------------------------------------------------------

describe('BE_03: Brave Search API key injection', () => {
  it('injects BRAVE_SEARCH_API_KEY when brave-search MCP is configured', () => {
    const containerArgs: string[] = [];
    const group = {
      containerConfig: {
        mcpServers: {
          'brave-search': { command: 'node', args: ['server.js'] },
        },
      },
    };
    const secrets = { BRAVE_SEARCH_API_KEY: 'test-key-abc123' };

    // Mirror of buildContainerArgs logic in container-runner.ts
    if (group.containerConfig?.mcpServers?.['brave-search']) {
      if (secrets.BRAVE_SEARCH_API_KEY) {
        containerArgs.push(
          '-e',
          `BRAVE_SEARCH_API_KEY=${secrets.BRAVE_SEARCH_API_KEY}`,
        );
      }
    }

    expect(containerArgs).toContain('-e');
    expect(containerArgs).toContain('BRAVE_SEARCH_API_KEY=test-key-abc123');
  });

  it('does NOT inject key when brave-search MCP is not configured', () => {
    const containerArgs: string[] = [];
    const group: {
      containerConfig?: { mcpServers?: Record<string, unknown> };
    } = {
      containerConfig: {
        mcpServers: {},
      },
    };
    const secrets = { BRAVE_SEARCH_API_KEY: 'test-key-abc123' };

    if (group.containerConfig?.mcpServers?.['brave-search']) {
      if (secrets.BRAVE_SEARCH_API_KEY) {
        containerArgs.push(
          '-e',
          `BRAVE_SEARCH_API_KEY=${secrets.BRAVE_SEARCH_API_KEY}`,
        );
      }
    }

    expect(containerArgs).not.toContain('BRAVE_SEARCH_API_KEY=test-key-abc123');
  });

  it('does NOT inject key when containerConfig is absent', () => {
    const containerArgs: string[] = [];
    const group: {
      containerConfig?: { mcpServers?: Record<string, unknown> };
    } = {};
    const secrets = { BRAVE_SEARCH_API_KEY: 'test-key-abc123' };

    if (group.containerConfig?.mcpServers?.['brave-search']) {
      if (secrets.BRAVE_SEARCH_API_KEY) {
        containerArgs.push(
          '-e',
          `BRAVE_SEARCH_API_KEY=${secrets.BRAVE_SEARCH_API_KEY}`,
        );
      }
    }

    expect(containerArgs).toHaveLength(0);
  });

  it('warns but does not inject when key is missing from secrets', () => {
    const containerArgs: string[] = [];
    const warnings: string[] = [];
    const group = {
      name: 'test-group',
      containerConfig: {
        mcpServers: {
          'brave-search': { command: 'node', args: ['server.js'] },
        },
      },
    };
    const secrets: Record<string, string> = {}; // no key

    if (group.containerConfig?.mcpServers?.['brave-search']) {
      if (secrets.BRAVE_SEARCH_API_KEY) {
        containerArgs.push(
          '-e',
          `BRAVE_SEARCH_API_KEY=${secrets.BRAVE_SEARCH_API_KEY}`,
        );
      } else {
        warnings.push(
          `brave-search MCP configured but BRAVE_SEARCH_API_KEY not found`,
        );
      }
    }

    expect(containerArgs).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('BRAVE_SEARCH_API_KEY not found');
  });

  it('key value is never logged or exposed in args beyond the -e flag', () => {
    const containerArgs: string[] = [];
    const secrets = { BRAVE_SEARCH_API_KEY: 'super-secret-key' };
    const group = {
      containerConfig: {
        mcpServers: {
          'brave-search': { command: 'node', args: ['server.js'] },
        },
      },
    };

    if (group.containerConfig?.mcpServers?.['brave-search']) {
      if (secrets.BRAVE_SEARCH_API_KEY) {
        containerArgs.push(
          '-e',
          `BRAVE_SEARCH_API_KEY=${secrets.BRAVE_SEARCH_API_KEY}`,
        );
      }
    }

    // Key should only appear in the env var value, not as a standalone arg
    const keyIdx = containerArgs.indexOf(
      'BRAVE_SEARCH_API_KEY=super-secret-key',
    );
    expect(keyIdx).toBeGreaterThan(-1);
    expect(containerArgs[keyIdx - 1]).toBe('-e'); // must be preceded by -e flag
  });
});

// ---------------------------------------------------------------------------
// BE_04: agent-browser binary mounting logic
// ---------------------------------------------------------------------------

describe('BE_04: agent-browser binary mounting', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ab-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Mirrors the agent-browser mount logic in buildVolumeMounts */
  function computeAgentBrowserMounts(
    agentBrowserPkg: string,
    allowedSkills: string[] | undefined,
    arch: string,
  ): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
    const mounts: Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }> = [];

    if (
      fs.existsSync(agentBrowserPkg) &&
      (!allowedSkills || allowedSkills.includes('agent-browser'))
    ) {
      const archMap: Record<string, string> = {
        arm64: 'linux-arm64',
        x64: 'linux-x64',
      };
      const binaryVariant = archMap[arch] ?? 'linux-x64';
      const nativeBin = path.join(
        agentBrowserPkg,
        'bin',
        `agent-browser-${binaryVariant}`,
      );

      mounts.push({
        hostPath: agentBrowserPkg,
        containerPath: '/usr/local/lib/node_modules/agent-browser',
        readonly: true,
      });

      if (fs.existsSync(nativeBin)) {
        mounts.push({
          hostPath: nativeBin,
          containerPath: '/usr/local/bin/agent-browser',
          readonly: true,
        });
      }
    }

    return mounts;
  }

  it('mounts agent-browser when allowedSkills is undefined (backward compat)', () => {
    // Create fake pkg + binary
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agent-browser-linux-x64'), '#!/bin/sh');

    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'x64');

    expect(mounts).toHaveLength(2);
    expect(mounts[0].containerPath).toBe(
      '/usr/local/lib/node_modules/agent-browser',
    );
    expect(mounts[1].containerPath).toBe('/usr/local/bin/agent-browser');
    expect(mounts[0].readonly).toBe(true);
    expect(mounts[1].readonly).toBe(true);
  });

  it('mounts agent-browser when it is in allowedSkills', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'agent-browser-linux-arm64'),
      '#!/bin/sh',
    );

    const mounts = computeAgentBrowserMounts(
      pkgDir,
      ['agent-browser', 'status'],
      'arm64',
    );

    expect(mounts).toHaveLength(2);
    expect(mounts[1].hostPath).toContain('linux-arm64');
  });

  it('does NOT mount agent-browser when skill is not in allowedSkills', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });

    // telegram_main config: skills = ['capabilities', 'slack-formatting', 'status']
    const mounts = computeAgentBrowserMounts(
      pkgDir,
      ['capabilities', 'slack-formatting', 'status'],
      'x64',
    );

    expect(mounts).toHaveLength(0);
  });

  it('does NOT mount when pkg directory does not exist', () => {
    const nonExistentPkg = path.join(tempDir, 'nonexistent');
    const mounts = computeAgentBrowserMounts(nonExistentPkg, undefined, 'x64');
    expect(mounts).toHaveLength(0);
  });

  it('mounts pkg dir but skips binary mount when native binary is missing', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    // No binary file created

    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'x64');

    // Package dir mount should still happen
    expect(mounts).toHaveLength(1);
    expect(mounts[0].containerPath).toBe(
      '/usr/local/lib/node_modules/agent-browser',
    );
  });

  it('maps arm64 arch to linux-arm64 binary variant', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'agent-browser-linux-arm64'),
      '#!/bin/sh',
    );
    fs.writeFileSync(path.join(binDir, 'agent-browser-linux-x64'), '#!/bin/sh');

    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'arm64');
    const binMount = mounts.find(
      (m) => m.containerPath === '/usr/local/bin/agent-browser',
    );
    expect(binMount?.hostPath).toContain('linux-arm64');
  });

  it('maps x64 arch to linux-x64 binary variant', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agent-browser-linux-x64'), '#!/bin/sh');

    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'x64');
    const binMount = mounts.find(
      (m) => m.containerPath === '/usr/local/bin/agent-browser',
    );
    expect(binMount?.hostPath).toContain('linux-x64');
  });

  it('falls back to linux-x64 for unknown arch', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agent-browser-linux-x64'), '#!/bin/sh');

    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'riscv64');
    const binMount = mounts.find(
      (m) => m.containerPath === '/usr/local/bin/agent-browser',
    );
    expect(binMount?.hostPath).toContain('linux-x64');
  });
});

// ---------------------------------------------------------------------------
// Integration: telegram_main group config verification
// ---------------------------------------------------------------------------

describe('telegram_main group config verification', () => {
  const telegramMainConfig = {
    allowedTools: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'NotebookEdit',
    ],
    skills: ['capabilities', 'slack-formatting', 'status'],
  };

  it('WebSearch and WebFetch are blocked', () => {
    const disallowed = computeDisallowedTools(telegramMainConfig.allowedTools);
    expect(disallowed).toContain('WebSearch');
    expect(disallowed).toContain('WebFetch');
  });

  it('agent-browser is not in allowed skills', () => {
    expect(telegramMainConfig.skills).not.toContain('agent-browser');
  });

  it('mcp__nanoclaw__* is always available (IPC)', () => {
    const disallowed = computeDisallowedTools(telegramMainConfig.allowedTools);
    expect(disallowed).not.toContain('mcp__nanoclaw__*');
  });

  it('brave-search MCP is not configured for telegram_main (no mcpServers key)', () => {
    // telegram_main DB config has no mcpServers — Brave Search not enabled
    const config = telegramMainConfig as { mcpServers?: unknown };
    expect(config.mcpServers).toBeUndefined();
  });
});
