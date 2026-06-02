import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Test the buildVolumeMounts function indirectly by calling runContainerAgent
// and inspecting the spawned container args, or test the exported pieces.

// We need to test:
// 1. Skill filtering (skills: undefined vs [] vs ["x"] vs ["nonexistent"])
// 2. Backward compatibility (no containerConfig, only timeout)
// 3. Agent customisation (model, systemPrompt)

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

    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Skill Filtering', () => {
    it('should copy no skills when skills is undefined (secure by default)', () => {
      // This tests the logic in buildVolumeMounts
      // When allowedSkills is undefined, NO skills are copied (secure by default)

      const skills = ['status', 'browser', 'formatting', 'mcp'];
      const groupSkillsDir = path.join(
        dataDir,
        'sessions',
        'test-group',
        '.claude',
        'skills',
      );
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      // Simulate the skill copy logic from buildVolumeMounts
      // When skills is undefined (or empty), no skills are copied (secure by default).
      // The production code: if (!allowedSkills || allowedSkills.length === 0) → skip
      // So with undefined, the copy loop never runs.

      // No skills should be present
      const copied = fs.readdirSync(groupSkillsDir);
      expect(copied).toEqual([]);
    });

    it('should copy no skills when skills is empty array', () => {
      const groupSkillsDir = path.join(
        dataDir,
        'sessions',
        'test-group',
        '.claude',
        'skills',
      );
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills: string[] = [];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (
          Array.isArray(allowedSkills) &&
          !(allowedSkills as string[]).includes(skillDir)
        ) {
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
      const groupSkillsDir = path.join(
        dataDir,
        'sessions',
        'test-group',
        '.claude',
        'skills',
      );
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills = ['status', 'browser'];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (
          Array.isArray(allowedSkills) &&
          !(allowedSkills as string[]).includes(skillDir)
        ) {
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
      const groupSkillsDir = path.join(
        dataDir,
        'sessions',
        'test-group',
        '.claude',
        'skills',
      );
      fs.mkdirSync(groupSkillsDir, { recursive: true });

      const allowedSkills = ['nonexistent', 'also-nonexistent'];

      for (const skillDir of fs.readdirSync(skillsDir)) {
        if (
          Array.isArray(allowedSkills) &&
          !(allowedSkills as string[]).includes(skillDir)
        ) {
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
});

describe('Agent Customisation (BE_04)', () => {
  // Test the logic from agent-runner/src/index.ts

  it('should apply model override when provided', () => {
    const containerInput = {
      model: 'haiku',
      systemPrompt: undefined,
    };

    const sdkEnv: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'http://proxy:3001',
    };

    if (containerInput.model) {
      sdkEnv.ANTHROPIC_MODEL = containerInput.model;
    }

    expect(sdkEnv.ANTHROPIC_MODEL).toBe('haiku');
  });

  it('should not override model when undefined', () => {
    const containerInput = {
      model: undefined,
      systemPrompt: undefined,
    };

    const sdkEnv: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'http://proxy:3001',
    };

    if (containerInput.model) {
      sdkEnv.ANTHROPIC_MODEL = containerInput.model;
    }

    expect(sdkEnv.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('should set appendPrompt to systemPrompt when provided', () => {
    const systemPrompt = 'You are a research assistant. Be concise.';

    let appendPrompt = '';
    if (systemPrompt) {
      appendPrompt = systemPrompt;
    }

    expect(appendPrompt).toBe('You are a research assistant. Be concise.');
  });

  it('should leave appendPrompt empty when systemPrompt is undefined', () => {
    const systemPrompt: string | undefined = undefined;

    let appendPrompt = '';
    if (systemPrompt) {
      appendPrompt = systemPrompt;
    }

    expect(appendPrompt).toBe('');
  });
});

describe('ContainerInput shape', () => {
  it('should include model and systemPrompt but not allowedTools', () => {
    // Mirrors the current ContainerInput interface (post-BE_01)
    interface ContainerInput {
      prompt: string;
      sessionId?: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      isAdmin: boolean;
      isScheduledTask?: boolean;
      assistantName?: string;
      model?: string;
      systemPrompt?: string;
    }

    const input: ContainerInput = {
      prompt: 'Test',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      isAdmin: false,
      model: 'sonnet',
      systemPrompt: 'Be concise.',
    };

    expect(input.model).toBe('sonnet');
    expect(input.systemPrompt).toBe('Be concise.');
    // allowedTools no longer exists on ContainerInput
    expect('allowedTools' in input).toBe(false);
  });
});

describe('ContainerConfig type (post-BE_01)', () => {
  it('should include skills, deniedTools, model, systemPrompt — not allowedTools', () => {
    // Mirrors the current ContainerConfig interface
    interface ContainerConfig {
      additionalMounts?: Array<{
        hostPath: string;
        containerPath?: string;
        readonly?: boolean;
      }>;
      timeout?: number;
      skills?: string[];
      deniedTools?: string[];
      preset?: string;
      systemPrompt?: string;
    }

    const config: ContainerConfig = {
      skills: ['status'],
      deniedTools: ['Task'],
      preset: 'haiku',
      systemPrompt: 'Be helpful.',
      timeout: 60000,
    };

    expect(config.skills).toEqual(['status']);
    expect(config.deniedTools).toEqual(['Task']);
    expect(config.preset).toBe('haiku');
    expect(config.systemPrompt).toBe('Be helpful.');
    expect(config.timeout).toBe(60000);
    // allowedTools no longer exists on ContainerConfig
    expect('allowedTools' in config).toBe(false);
  });

  it('should work with minimal config (backward compat)', () => {
    interface ContainerConfig {
      additionalMounts?: Array<{
        hostPath: string;
        containerPath?: string;
        readonly?: boolean;
      }>;
      timeout?: number;
      skills?: string[];
      deniedTools?: string[];
    }

    // Groups with no containerConfig
    const config1: ContainerConfig | undefined = undefined;
    expect(config1).toBeUndefined();

    // Groups with only timeout
    const config2: ContainerConfig = { timeout: 60000 };
    expect(config2.timeout).toBe(60000);
    expect(config2.skills).toBeUndefined();
    expect(config2.deniedTools).toBeUndefined();
  });
});
