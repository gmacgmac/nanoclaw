/**
 * Host-side skill reader — reads extracted skill files from a group's
 * extracted-skills/ directory and parses YAML frontmatter.
 */

import fs from 'fs';
import path from 'path';

export interface ExtractedSkill {
  name: string;
  extracted: string; // YYYY-MM-DD
  sourceGroup: string;
  confidence: 'high' | 'medium' | 'low';
  filePath: string; // absolute path to the .md file
}

/**
 * Parse YAML frontmatter from a Markdown file's content.
 * Returns null if no valid frontmatter found.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * Read all extracted skill files from a group's extracted-skills/ directory.
 * Returns typed array of skill objects. Gracefully handles missing directory,
 * malformed frontmatter, and empty files.
 */
export function getExtractedSkills(groupFolder: string): ExtractedSkill[] {
  const skillsDir = path.join(groupFolder, 'extracted-skills');

  if (!fs.existsSync(skillsDir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const skills: ExtractedSkill[] = [];

  for (const file of entries) {
    const filePath = path.join(skillsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.trim()) continue;

      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const name = fm.name;
      const extracted = fm.extracted;
      const sourceGroup = fm.source_group || '';
      const confidence = fm.confidence;

      if (!name || !extracted) continue;
      if (!VALID_CONFIDENCE.has(confidence)) continue;

      skills.push({
        name,
        extracted,
        sourceGroup,
        confidence: confidence as 'high' | 'medium' | 'low',
        filePath,
      });
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  return skills;
}
