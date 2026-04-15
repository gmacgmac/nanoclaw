/**
 * BE_08 — Skill Loading Integration Tests
 *
 * Tests extracted skill copying into the container's skill directory
 * during buildVolumeMounts(). Verifies learningLoop flag behavior:
 * true → copy, false/undefined/'extract-only' → skip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getExtractedSkills } from './skill-manager.js';

let tmpDir: string;
let groupDir: string;
let sessionsDir: string;

function writeSkillFile(name: string, content: string): void {
  const dir = path.join(groupDir, 'extracted-skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

function validSkill(name: string, date = '2026-04-14'): string {
  return [
    '---',
    `name: ${name}`,
    `extracted: ${date}`,
    'source_group: test-group',
    'confidence: high',
    '---',
    '',
    `# ${name}`,
    '## When to Use',
    'When testing.',
  ].join('\n');
}

/**
 * Simulate the extracted skill copying logic from buildVolumeMounts().
 * This is a direct extraction of the logic to test in isolation without
 * needing to mock the entire container-runner infrastructure.
 */
function copyExtractedSkills(
  groupFolder: string,
  skillsDst: string,
  learningLoop?: boolean | 'extract-only',
): number {
  if (learningLoop !== true) return 0;

  const skills = getExtractedSkills(groupFolder);
  if (skills.length === 0) return 0;

  const extractedDst = path.join(skillsDst, 'extracted');
  fs.mkdirSync(extractedDst, { recursive: true });
  for (const skill of skills) {
    const dstFile = path.join(extractedDst, path.basename(skill.filePath));
    fs.copyFileSync(skill.filePath, dstFile);
  }
  return skills.length;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-load-'));
  groupDir = path.join(tmpDir, 'group');
  sessionsDir = path.join(tmpDir, 'sessions', '.claude', 'skills');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extracted skill loading', () => {
  it('learningLoop: true → copies extracted skills to skills/extracted/', () => {
    writeSkillFile('deploy-flow.md', validSkill('deploy-flow'));
    writeSkillFile('debug-pattern.md', validSkill('debug-pattern'));

    const count = copyExtractedSkills(groupDir, sessionsDir, true);

    expect(count).toBe(2);
    const extractedDir = path.join(sessionsDir, 'extracted');
    expect(fs.existsSync(extractedDir)).toBe(true);
    const files = fs.readdirSync(extractedDir);
    expect(files.sort()).toEqual(['debug-pattern.md', 'deploy-flow.md']);

    // Verify content is actually copied
    const content = fs.readFileSync(
      path.join(extractedDir, 'deploy-flow.md'),
      'utf-8',
    );
    expect(content).toContain('name: deploy-flow');
  });

  it('learningLoop: false → no extracted skills copied', () => {
    writeSkillFile('deploy-flow.md', validSkill('deploy-flow'));

    const count = copyExtractedSkills(groupDir, sessionsDir, false);

    expect(count).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir, 'extracted'))).toBe(false);
  });

  it('learningLoop: "extract-only" → no extracted skills copied', () => {
    writeSkillFile('deploy-flow.md', validSkill('deploy-flow'));

    const count = copyExtractedSkills(groupDir, sessionsDir, 'extract-only');

    expect(count).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir, 'extracted'))).toBe(false);
  });

  it('learningLoop: undefined → no extracted skills copied (backward compat)', () => {
    writeSkillFile('deploy-flow.md', validSkill('deploy-flow'));

    const count = copyExtractedSkills(groupDir, sessionsDir, undefined);

    expect(count).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir, 'extracted'))).toBe(false);
  });

  it('empty extracted-skills/ directory → no error, no skills copied', () => {
    fs.mkdirSync(path.join(groupDir, 'extracted-skills'), { recursive: true });

    const count = copyExtractedSkills(groupDir, sessionsDir, true);

    expect(count).toBe(0);
    // extracted/ subdir should not be created when there are no skills
    expect(fs.existsSync(path.join(sessionsDir, 'extracted'))).toBe(false);
  });

  it('missing extracted-skills/ directory → no error, no skills copied', () => {
    // groupDir exists but has no extracted-skills/ subdirectory
    const count = copyExtractedSkills(groupDir, sessionsDir, true);

    expect(count).toBe(0);
    expect(fs.existsSync(path.join(sessionsDir, 'extracted'))).toBe(false);
  });

  it('skips malformed skill files (only copies valid ones)', () => {
    writeSkillFile('good.md', validSkill('good-skill'));
    writeSkillFile('bad.md', '# No frontmatter here');
    writeSkillFile(
      'incomplete.md',
      '---\nname: incomplete\n---\n# Missing fields',
    );

    const count = copyExtractedSkills(groupDir, sessionsDir, true);

    expect(count).toBe(1);
    const files = fs.readdirSync(path.join(sessionsDir, 'extracted'));
    expect(files).toEqual(['good.md']);
  });

  it('skills are placed in extracted/ subdirectory (not root skills/)', () => {
    // Pre-populate a built-in skill to verify it's not disturbed
    const builtinDir = path.join(sessionsDir, 'status');
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, 'SKILL.md'), '# Status skill');

    writeSkillFile('new-skill.md', validSkill('new-skill'));

    copyExtractedSkills(groupDir, sessionsDir, true);

    // Built-in skill untouched
    expect(fs.existsSync(path.join(builtinDir, 'SKILL.md'))).toBe(true);
    // Extracted skill in extracted/ subdirectory
    expect(
      fs.existsSync(path.join(sessionsDir, 'extracted', 'new-skill.md')),
    ).toBe(true);
  });
});
