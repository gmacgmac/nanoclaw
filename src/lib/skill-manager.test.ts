/**
 * BE_07 — Skill Manager Tests
 *
 * Tests getExtractedSkills(): parsing valid skill files, handling
 * malformed/missing frontmatter, missing directories, and empty files.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getExtractedSkills } from './skill-manager.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mgr-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(name: string, content: string): void {
  const dir = path.join(tmpDir, 'extracted-skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

describe('getExtractedSkills', () => {
  it('parses a valid skill file with correct frontmatter', () => {
    writeSkill(
      'deploy-workflow.md',
      [
        '---',
        'name: deploy-workflow',
        'extracted: 2026-04-14',
        'source_group: dev-team',
        'confidence: high',
        '---',
        '',
        '# Deploy Workflow',
        '## When to Use',
        'When deploying to production.',
      ].join('\n'),
    );

    const skills = getExtractedSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: 'deploy-workflow',
      extracted: '2026-04-14',
      sourceGroup: 'dev-team',
      confidence: 'high',
      filePath: path.join(tmpDir, 'extracted-skills', 'deploy-workflow.md'),
    });
  });

  it('parses multiple skill files', () => {
    writeSkill(
      'skill-a.md',
      '---\nname: skill-a\nextracted: 2026-04-14\nconfidence: high\n---\n# A',
    );
    writeSkill(
      'skill-b.md',
      '---\nname: skill-b\nextracted: 2026-04-13\nsource_group: ops\nconfidence: medium\n---\n# B',
    );

    const skills = getExtractedSkills(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
  });

  it('returns empty array when extracted-skills/ directory does not exist', () => {
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('returns empty array when extracted-skills/ directory is empty', () => {
    fs.mkdirSync(path.join(tmpDir, 'extracted-skills'), { recursive: true });
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips files with no YAML frontmatter', () => {
    writeSkill('no-frontmatter.md', '# Just a heading\nSome content.');
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips files with empty frontmatter', () => {
    writeSkill('empty-fm.md', '---\n---\n# Empty');
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips files missing required name field', () => {
    writeSkill(
      'no-name.md',
      '---\nextracted: 2026-04-14\nconfidence: high\n---\n# No Name',
    );
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips files missing required extracted field', () => {
    writeSkill(
      'no-date.md',
      '---\nname: no-date\nconfidence: high\n---\n# No Date',
    );
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips files with invalid confidence value', () => {
    writeSkill(
      'bad-conf.md',
      '---\nname: bad-conf\nextracted: 2026-04-14\nconfidence: extreme\n---\n# Bad',
    );
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips empty files', () => {
    writeSkill('empty.md', '');
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('skips whitespace-only files', () => {
    writeSkill('whitespace.md', '   \n\n  ');
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('handles missing source_group gracefully (defaults to empty string)', () => {
    writeSkill(
      'no-group.md',
      '---\nname: no-group\nextracted: 2026-04-14\nconfidence: low\n---\n# No Group',
    );
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].sourceGroup).toBe('');
  });

  it('ignores non-.md files in the directory', () => {
    const dir = path.join(tmpDir, 'extracted-skills');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a skill');
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toEqual([]);
  });

  it('handles frontmatter with colons in values', () => {
    writeSkill(
      'colon-val.md',
      '---\nname: deploy: staging\nextracted: 2026-04-14\nconfidence: medium\n---\n# Deploy',
    );
    const skills = getExtractedSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy: staging');
  });
});
