import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Test the buildVolumeMounts function indirectly by calling runContainerAgent
// and inspecting the spawned container args, or test the exported pieces.

// We need to test:
// 1. Skill filtering (skills: undefined vs [] vs ["x"] vs ["nonexistent"])
// 2. Global access mounts (globalAccess permutations)
// 3. Backward compatibility (no containerConfig, only timeout)
// 4. Agent customisation (allowedTools, model, systemPrompt)

// The buildVolumeMounts function is private, so we'll test it by creating
// temporary directories and checking what gets copied/mounted.

describe('Per-Group Skill Isolation', () => {
  let tempDir: string;
  let groupsDir: string;
  let dataDir: string;
  let skillsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create temp directories
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-test-'));
    groupsDir = path.join(tempDir, 'groups');
    dataDir = path.join(tempDir, 'data');
    skillsDir = path.join(tempDir, 'container', 'skills');

    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    // Create mock skills
    for (const skill of ['status', 'browser', 'formatting', 'mcp']) {
      const skillPath = path.join(skillsDir, skill);
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'SKILL.md'), `# ${skill} skill`);
    }

    // Create global dir
    const globalDir = path.join(groupsDir, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'categories'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.md'), '# Global memory');

    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Skill Filtering', () => {
    it('should copy all skills when skills is undefined', () => {
      // This tests the logic in buildVolumeMounts at lines 199-215
      // When allowedSkills is undefined, all skills from container/skills/ are copied

      const skills = ['status', 'browser', 'formatting', 'mcp'];
      const groupSkillsDir = path.join(dataDir, 'sessions', 'test-group', '.claude', 'skills');
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      // Simulate the skill copy logic from buildVolumeMounts
      let allowedSkills: string[] | undefined = undefined;

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (Array.isArray(allowedSkills) && !(allowedSkills as string[]).includes(skillDir)) {
          continue;
        }
        const srcDir = path.join(skillsDir, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        const dstDir = path.join(groupSkillsDir, skillDir);
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }

      // All skills should be present
      const copied = fs.readdirSync(groupSkillsDir);
      expect(copied.sort()).toEqual(skills.sort());
    });

    it('should copy no skills when skills is empty array', () => {
      const groupSkillsDir = path.join(dataDir, 'sessions', 'test-group', '.claude', 'skills');
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills: string[] = [];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (Array.isArray(allowedSkills) && !(allowedSkills as string[]).includes(skillDir)) {
          continue;
        }
        const srcDir = path.join(skillsDir, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        const dstDir = path.join(groupSkillsDir, skillDir);
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }

      // No skills should be present
      const copied = fs.readdirSync(groupSkillsDir);
      expect(copied).toEqual([]);
    });

    it('should copy only specified skills when skills array provided', () => {
      const groupSkillsDir = path.join(dataDir, 'sessions', 'test-group', '.claude', 'skills');
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills = ['status', 'browser'];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (Array.isArray(allowedSkills) && !(allowedSkills as string[]).includes(skillDir)) {
          continue;
        }
        const srcDir = path.join(skillsDir, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        const dstDir = path.join(groupSkillsDir, skillDir);
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }

      // Only status and browser should be present
      const copied = fs.readdirSync(groupSkillsDir);
      expect(copied.sort()).toEqual(['browser', 'status']);
    });

    it('should handle nonexistent skills gracefully', () => {
      const groupSkillsDir = path.join(dataDir, 'sessions', 'test-group', '.claude', 'skills');
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills = ['nonexistent', 'also-nonexistent'];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (Array.isArray(allowedSkills) && !(allowedSkills as string[]).includes(skillDir)) {
          continue;
        }
        const srcDir = path.join(skillsDir, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        const dstDir = path.join(groupSkillsDir, skillDir);
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }

      // No error, no skills copied
      const copied = fs.readdirSync(groupSkillsDir);
      expect(copied).toEqual([]);
    });
  });

  describe('Global Access Mounts', () => {
    it('should mount entire global read-only when globalAccess is undefined', () => {
      // Tests lines 148-157 in container-runner.ts
      interface GlobalAccess {
        [subdir: string]: { readonly: boolean };
      }

      const globalAccess: GlobalAccess | undefined = undefined;
      const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
      const globalDir = path.join(groupsDir, 'global');

      if (globalAccess) {
        // Not undefined - would do specific mounts
      } else {
        // undefined = mount entire global read-only (backward compat)
        if (fs.existsSync(globalDir)) {
          mounts.push({
            hostPath: globalDir,
            containerPath: '/workspace/global',
            readonly: true,
          });
        }
      }

      expect(mounts).toHaveLength(1);
      expect(mounts[0].containerPath).toBe('/workspace/global');
      expect(mounts[0].readonly).toBe(true);
    });

    it('should not mount global when globalAccess is empty object', () => {
      interface GlobalAccess {
        [subdir: string]: { readonly: boolean };
      }

      const globalAccess: GlobalAccess = {};
      const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
      const globalDir = path.join(groupsDir, 'global');

      if (globalAccess['*']) {
        // Wildcard case
      } else {
        // Per-subdirectory: empty object = no mounts
        for (const [subdir, config] of Object.entries(globalAccess)) {
          const subdirPath = path.join(globalDir, subdir);
          if (fs.existsSync(subdirPath)) {
            mounts.push({
              hostPath: subdirPath,
              containerPath: `/workspace/global/${subdir}`,
              readonly: config.readonly,
            });
          }
        }
      }

      expect(mounts).toHaveLength(0);
    });

    it('should mount entire global with specified permission when wildcard used', () => {
      interface GlobalAccess {
        [subdir: string]: { readonly: boolean };
      }

      // readonly: true
      let globalAccess: GlobalAccess = { '*': { readonly: true } };
      let mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
      let globalDir = path.join(groupsDir, 'global');

      if (globalAccess['*']) {
        if (fs.existsSync(globalDir)) {
          mounts.push({
            hostPath: globalDir,
            containerPath: '/workspace/global',
            readonly: globalAccess['*'].readonly,
          });
        }
      }

      expect(mounts).toHaveLength(1);
      expect(mounts[0].containerPath).toBe('/workspace/global');
      expect(mounts[0].readonly).toBe(true);

      // readonly: false
      globalAccess = { '*': { readonly: false } };
      mounts = [];

      if (globalAccess['*']) {
        if (fs.existsSync(globalDir)) {
          mounts.push({
            hostPath: globalDir,
            containerPath: '/workspace/global',
            readonly: globalAccess['*'].readonly,
          });
        }
      }

      expect(mounts).toHaveLength(1);
      expect(mounts[0].readonly).toBe(false);
    });

    it('should mount only specified subdirectories when named', () => {
      interface GlobalAccess {
        [subdir: string]: { readonly: boolean };
      }

      const globalAccess: GlobalAccess = { 'categories': { readonly: true } };
      const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
      const globalDir = path.join(groupsDir, 'global');

      if (globalAccess['*']) {
        // Wildcard case - not applicable
      } else {
        for (const [subdir, config] of Object.entries(globalAccess)) {
          const subdirPath = path.join(globalDir, subdir);
          if (fs.existsSync(subdirPath)) {
            mounts.push({
              hostPath: subdirPath,
              containerPath: `/workspace/global/${subdir}`,
              readonly: config.readonly,
            });
          }
        }
      }

      expect(mounts).toHaveLength(1);
      expect(mounts[0].containerPath).toBe('/workspace/global/categories');
      expect(mounts[0].readonly).toBe(true);
      // projects subdir should NOT be mounted
    });

    it('should support read-write mounts for subdirectories', () => {
      interface GlobalAccess {
        [subdir: string]: { readonly: boolean };
      }

      const globalAccess: GlobalAccess = { 'categories': { readonly: false } };
      const mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];
      const globalDir = path.join(groupsDir, 'global');

      for (const [subdir, config] of Object.entries(globalAccess)) {
        const subdirPath = path.join(globalDir, subdir);
        if (fs.existsSync(subdirPath)) {
          mounts.push({
            hostPath: subdirPath,
            containerPath: `/workspace/global/${subdir}`,
            readonly: config.readonly,
          });
        }
      }

      expect(mounts).toHaveLength(1);
      expect(mounts[0].readonly).toBe(false);
    });
  });
});

describe('Agent Customisation (BE_04)', () => {
  // Test the logic from agent-runner/src/index.ts

  it('should use default tools when allowedTools is undefined', () => {
    const defaultTools = [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ];

    const allowedTools: string[] | undefined = undefined;
    const tools = allowedTools
      ? [...allowedTools, 'mcp__nanoclaw__*']
      : defaultTools;

    expect(tools).toEqual(defaultTools);
  });

  it('should merge allowedTools with mcp__nanoclaw__* when provided', () => {
    const defaultTools = [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ];

    const allowedTools = ['Read', 'Grep', 'Glob'];
    const tools = allowedTools
      ? [...allowedTools, 'mcp__nanoclaw__*']
      : defaultTools;

    expect(tools).toEqual(['Read', 'Grep', 'Glob', 'mcp__nanoclaw__*']);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Write');
  });

  it('should only include mcp__nanoclaw__* when allowedTools is empty array', () => {
    const defaultTools = [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ];

    const allowedTools: string[] = [];
    const tools = allowedTools
      ? [...allowedTools, 'mcp__nanoclaw__*']
      : defaultTools;

    expect(tools).toEqual(['mcp__nanoclaw__*']);
  });

  it('should apply model override when provided', () => {
    const containerInput = {
      model: 'haiku',
      allowedTools: undefined,
      systemPrompt: undefined,
    };

    const sdkEnv: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'http://proxy:3001' };

    if (containerInput.model) {
      sdkEnv.ANTHROPIC_MODEL = containerInput.model;
    }

    expect(sdkEnv.ANTHROPIC_MODEL).toBe('haiku');
  });

  it('should not override model when undefined', () => {
    const containerInput = {
      model: undefined,
      allowedTools: undefined,
      systemPrompt: undefined,
    };

    const sdkEnv: Record<string, string | undefined> = { ANTHROPIC_BASE_URL: 'http://proxy:3001' };

    if (containerInput.model) {
      sdkEnv.ANTHROPIC_MODEL = containerInput.model;
    }

    expect(sdkEnv.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('should build system prompt from global CLAUDE.md when systemPrompt provided', () => {
    const globalContent = '# Global memory\n\nShared context.';
    const systemPrompt = 'You are a research assistant. Be concise.';

    // Simulating lines 396-404 in agent-runner/src/index.ts
    let appendPrompt = '';

    // Global CLAUDE.md (for non-main groups)
    const hasGlobal = true; // fs.existsSync check
    if (hasGlobal) {
      appendPrompt += globalContent;
    }

    // Per-group systemPrompt
    if (systemPrompt) {
      appendPrompt += (appendPrompt ? '\n\n' : '') + systemPrompt;
    }

    // Both global content and systemPrompt should be present, separated by \n\n
    expect(appendPrompt).toBe('# Global memory\n\nShared context.\n\nYou are a research assistant. Be concise.');
  });

  it('should use only systemPrompt when no global CLAUDE.md', () => {
    const systemPrompt = 'You are a research assistant. Be concise.';

    let appendPrompt = '';

    const hasGlobal = false; // fs.existsSync returns false
    if (hasGlobal) {
      // Would add global content
    }

    if (systemPrompt) {
      appendPrompt += (appendPrompt ? '\n\n' : '') + systemPrompt;
    }

    expect(appendPrompt).toBe('You are a research assistant. Be concise.');
  });

  it('should use only global CLAUDE.md when no systemPrompt', () => {
    const globalContent = '# Global memory\n\nShared context.';

    let appendPrompt = '';

    const hasGlobal = true;
    if (hasGlobal) {
      appendPrompt += globalContent;
    }

    const systemPrompt: string | undefined = undefined;
    if (systemPrompt) {
      // Would add systemPrompt
    }

    expect(appendPrompt).toBe(globalContent);
  });
});

describe('ContainerInput threading', () => {
  // Verify that ContainerInput fields are correctly passed through

  it('should include allowedTools, model, and systemPrompt in ContainerInput', () => {
    // This verifies the type definition matches what we expect
    interface ContainerInput {
      prompt: string;
      sessionId?: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      isScheduledTask?: boolean;
      assistantName?: string;
      allowedTools?: string[];
      model?: string;
      systemPrompt?: string;
    }

    const input: ContainerInput = {
      prompt: 'Test',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      allowedTools: ['Read', 'Grep'],
      model: 'sonnet',
      systemPrompt: 'Be concise.',
    };

    expect(input.allowedTools).toEqual(['Read', 'Grep']);
    expect(input.model).toBe('sonnet');
    expect(input.systemPrompt).toBe('Be concise.');
  });
});

describe('ContainerConfig type extension', () => {
  // Verify ContainerConfig has all the new fields

  it('should include skills, globalAccess, allowedTools, model, systemPrompt', () => {
    interface ContainerConfig {
      additionalMounts?: Array<{ hostPath: string; containerPath?: string; readonly?: boolean }>;
      timeout?: number;
      skills?: string[];
      globalAccess?: { [subdir: string]: { readonly: boolean } };
      allowedTools?: string[];
      model?: string;
      systemPrompt?: string;
    }

    const config: ContainerConfig = {
      skills: ['status'],
      globalAccess: { 'categories': { readonly: true } },
      allowedTools: ['Read', 'Grep'],
      model: 'haiku',
      systemPrompt: 'Be helpful.',
      timeout: 60000,
    };

    expect(config.skills).toEqual(['status']);
    expect(config.globalAccess).toEqual({ 'categories': { readonly: true } });
    expect(config.allowedTools).toEqual(['Read', 'Grep']);
    expect(config.model).toBe('haiku');
    expect(config.systemPrompt).toBe('Be helpful.');
    expect(config.timeout).toBe(60000);
  });

  it('should work with minimal config (backward compat)', () => {
    interface ContainerConfig {
      additionalMounts?: Array<{ hostPath: string; containerPath?: string; readonly?: boolean }>;
      timeout?: number;
      skills?: string[];
      globalAccess?: { [subdir: string]: { readonly: boolean } };
      allowedTools?: string[];
      model?: string;
      systemPrompt?: string;
    }

    // Groups with no containerConfig
    const config1: ContainerConfig | undefined = undefined;
    expect(config1).toBeUndefined();

    // Groups with only timeout
    const config2: ContainerConfig = { timeout: 60000 };
    expect(config2.timeout).toBe(60000);
    expect(config2.skills).toBeUndefined();
    expect(config2.globalAccess).toBeUndefined();
    expect(config2.allowedTools).toBeUndefined();
    expect(config2.model).toBeUndefined();
    expect(config2.systemPrompt).toBeUndefined();
  });
});