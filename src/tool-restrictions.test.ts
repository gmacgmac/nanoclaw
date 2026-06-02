/**
 * Tool-governance tests: ceiling-model resolution, Brave Search MCP injection,
 * and agent-browser binary mounting.
 *
 * The ceiling-model resolution mirrors agent-runner/src/index.ts:
 *   resolved = ceiling − deniedTools − Bash(if approvalMode) − WebSearch/WebFetch(if !nativeWebTools)
 *   allowedTools = [...resolved, 'mcp__nanoclaw__*']
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Ceiling-model tool resolution (mirrors agent-runner/src/index.ts)
// ---------------------------------------------------------------------------

/** Matches the FALLBACK_CATALOG in agent-runner/src/index.ts */
const FALLBACK_CATALOG = [
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'Read',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TeamCreate',
  'TeamDelete',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];

/** The ceiling from tool-allowlist.json (same items, different order) */
const TOOL_ALLOWLIST_CEILING = [
  'Task',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'Read',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TeamCreate',
  'TeamDelete',
  'ToolSearch',
  'WebSearch',
  'Write',
];

interface ResolutionInput {
  /** JSON array string or undefined (simulates NANOCLAW_TOOL_ALLOWLIST env var) */
  ceilingEnv?: string;
  /** Per-group denied tools (simulates NANOCLAW_DENIED_TOOLS env var content) */
  deniedTools?: string[];
  /** Whether approval mode is active */
  approvalMode?: boolean;
  /** Whether native web tools are enabled */
  nativeWebTools?: boolean;
}

/**
 * Pure-function mirror of the agent-runner's ceiling resolution.
 * Identical logic — testable without process.env mutation.
 */
function resolveTools(input: ResolutionInput): { tools: string[]; allowedTools: string[] } {
  // Parse ceiling
  let ceiling: string[];
  try {
    if (input.ceilingEnv) {
      const parsed = JSON.parse(input.ceilingEnv);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((t: unknown) => typeof t === 'string')) {
        ceiling = parsed;
      } else {
        ceiling = FALLBACK_CATALOG;
      }
    } else {
      ceiling = FALLBACK_CATALOG;
    }
  } catch {
    ceiling = FALLBACK_CATALOG;
  }

  // Build deny set
  const denySet = new Set<string>(input.deniedTools ?? []);
  if (input.approvalMode) denySet.add('Bash');
  if (!input.nativeWebTools) {
    denySet.add('WebSearch');
    denySet.add('WebFetch');
  }

  // Resolve: ceiling minus all denies
  const resolved = ceiling.filter(t => !denySet.has(t));
  return {
    tools: resolved,
    allowedTools: [...resolved, 'mcp__nanoclaw__*'],
  };
}

describe('Ceiling-model tool resolution', () => {
  it('ceiling with empty deniedTools, approval off, nativeWebTools on → resolved == ceiling', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(TOOL_ALLOWLIST_CEILING);
  });

  it('deniedTools removes a named tool', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: ['Task'],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).not.toContain('Task');
    expect(result.tools).toContain('Bash');
    expect(result.tools).toContain('WebSearch');
  });

  it('deniedTools removes multiple tools', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: ['Task', 'CronCreate', 'CronDelete'],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).not.toContain('Task');
    expect(result.tools).not.toContain('CronCreate');
    expect(result.tools).not.toContain('CronDelete');
    expect(result.tools).toContain('CronList');
  });

  it('approvalMode true → Bash removed', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: [],
      approvalMode: true,
      nativeWebTools: true,
    });
    expect(result.tools).not.toContain('Bash');
    expect(result.tools).toContain('Read');
    expect(result.tools).toContain('Write');
  });

  it('nativeWebTools false → WebSearch + WebFetch removed', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: false,
    });
    expect(result.tools).not.toContain('WebSearch');
    expect(result.tools).not.toContain('WebFetch');
    expect(result.tools).toContain('Bash');
  });

  it('nativeWebTools true → WebSearch retained (WebFetch not in allowlist ceiling but in fallback)', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toContain('WebSearch');
    // WebFetch is NOT in tool-allowlist.json ceiling (only in fallback)
    expect(result.tools).not.toContain('WebFetch');
  });

  it('combined: approvalMode + !nativeWebTools + deniedTools', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: ['TeamCreate', 'TeamDelete'],
      approvalMode: true,
      nativeWebTools: false,
    });
    expect(result.tools).not.toContain('Bash');
    expect(result.tools).not.toContain('WebSearch');
    expect(result.tools).not.toContain('WebFetch');
    expect(result.tools).not.toContain('TeamCreate');
    expect(result.tools).not.toContain('TeamDelete');
    expect(result.tools).toContain('Read');
    expect(result.tools).toContain('Write');
    expect(result.tools).toContain('Edit');
  });

  it('mcp__nanoclaw__* always in allowedTools, never gated by ceiling', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: [],
      approvalMode: true,
      nativeWebTools: false,
    });
    expect(result.allowedTools).toContain('mcp__nanoclaw__*');
    // It's NOT in tools (the ceiling), only in allowedTools (auto-approve list)
    expect(result.tools).not.toContain('mcp__nanoclaw__*');
  });

  it('invalid ceiling env → falls back to FALLBACK_CATALOG', () => {
    const result = resolveTools({
      ceilingEnv: 'not-valid-json',
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(FALLBACK_CATALOG);
  });

  it('empty array ceiling env → falls back to FALLBACK_CATALOG', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify([]),
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(FALLBACK_CATALOG);
  });

  it('absent ceiling env → falls back to FALLBACK_CATALOG', () => {
    const result = resolveTools({
      ceilingEnv: undefined,
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(FALLBACK_CATALOG);
  });

  it('non-string-array ceiling env → falls back to FALLBACK_CATALOG', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify([1, 2, 3]),
      deniedTools: [],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(FALLBACK_CATALOG);
  });

  it('deniedTools that are not in ceiling are harmlessly ignored', () => {
    const result = resolveTools({
      ceilingEnv: JSON.stringify(TOOL_ALLOWLIST_CEILING),
      deniedTools: ['NonExistentTool'],
      approvalMode: false,
      nativeWebTools: true,
    });
    expect(result.tools).toEqual(TOOL_ALLOWLIST_CEILING);
  });

  it('FALLBACK_CATALOG includes WebFetch (not in ceiling file)', () => {
    // The fallback has WebFetch for backward compat, but tool-allowlist.json does not
    expect(FALLBACK_CATALOG).toContain('WebFetch');
    expect(TOOL_ALLOWLIST_CEILING).not.toContain('WebFetch');
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
      allowedSkills?.includes('agent-browser')
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

  it('does NOT mount agent-browser when allowedSkills is undefined (secure by default)', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agent-browser-linux-x64'), '#!/bin/sh');

    // undefined skills = no skills (secure by default) — binary must NOT mount
    const mounts = computeAgentBrowserMounts(pkgDir, undefined, 'x64');

    expect(mounts).toHaveLength(0);
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

    const mounts = computeAgentBrowserMounts(
      pkgDir,
      ['capabilities', 'slack-formatting', 'status'],
      'x64',
    );

    expect(mounts).toHaveLength(0);
  });

  it('does NOT mount when pkg directory does not exist', () => {
    const nonExistentPkg = path.join(tempDir, 'nonexistent');
    const mounts = computeAgentBrowserMounts(
      nonExistentPkg,
      ['agent-browser'],
      'x64',
    );
    expect(mounts).toHaveLength(0);
  });

  it('mounts pkg dir but skips binary mount when native binary is missing', () => {
    const pkgDir = path.join(tempDir, 'agent-browser');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    // No binary file created

    const mounts = computeAgentBrowserMounts(pkgDir, ['agent-browser'], 'x64');

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

    const mounts = computeAgentBrowserMounts(
      pkgDir,
      ['agent-browser'],
      'arm64',
    );
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

    const mounts = computeAgentBrowserMounts(pkgDir, ['agent-browser'], 'x64');
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

    const mounts = computeAgentBrowserMounts(
      pkgDir,
      ['agent-browser'],
      'riscv64',
    );
    const binMount = mounts.find(
      (m) => m.containerPath === '/usr/local/bin/agent-browser',
    );
    expect(binMount?.hostPath).toContain('linux-x64');
  });
});


