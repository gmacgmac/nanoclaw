/**
 * BE_07 Flush Prompt Tests
 *
 * Tests the shared buildFlushPrompt() builder and its integration
 * with both getFlushPrompt() (agent-runner) and getNightlyFlushPrompt() (host).
 *
 * Focus: prompt structure, step ordering, skill extraction conditional inclusion,
 * internal tag wrapping, and suppression behavior.
 */
import { describe, expect, it } from 'vitest';

import { buildFlushPrompt } from '../src/lib/flush-prompt.js';
import { getNightlyFlushPrompt } from '../src/nightly-maintenance.js';

const today = new Date().toISOString().split('T')[0];

// --- Shared prompt validation ---
function validateFlushPrompt(prompt: string, label: string) {
  describe(`${label} — structure`, () => {
    it('starts with <internal> tag', () => {
      expect(prompt.startsWith('<internal>')).toBe(true);
    });

    it('ends with </internal> tag', () => {
      expect(prompt.trimEnd().endsWith('</internal>')).toBe(true);
    });

    it('is wrapped in internal tags', () => {
      expect(prompt).toContain('<internal>');
      expect(prompt).toContain('</internal>');
    });
  });

  describe(`${label} — MCP tool warning`, () => {
    it('includes the no-MCP-tools safety guardrail', () => {
      expect(prompt).toContain('Do NOT call manual_flush');
      expect(prompt).toContain('Do NOT call any tools starting with mcp__');
    });
  });

  describe(`${label} — MEMORY.md instructions`, () => {
    it('references memory/MEMORY.md', () => {
      expect(prompt).toContain('memory/MEMORY.md');
    });

    it('instructs to append new facts', () => {
      expect(prompt).toMatch(/[Aa]ppend.*NEW.*facts/i);
    });

    it('instructs to remove superseded facts', () => {
      expect(prompt).toMatch(/[Rr]emove.*superseded/i);
    });

    it('instructs not to duplicate existing facts', () => {
      expect(prompt).toMatch(/[Dd]o NOT duplicate/i);
    });
  });

  describe(`${label} — COMPACT.md instructions`, () => {
    it('references memory/COMPACT.md', () => {
      expect(prompt).toContain('memory/COMPACT.md');
    });

    it('caps at ~2000 words', () => {
      expect(prompt).toContain('2000 words');
    });

    it('instructs to overwrite', () => {
      expect(prompt).toMatch(/overwrite|fresh file/i);
    });
  });

  describe(`${label} — daily note instructions`, () => {
    it("references today's date in daily note path", () => {
      expect(prompt).toContain(`memory/${today}.md`);
    });
  });

  describe(`${label} — response format`, () => {
    it('instructs to reply with <internal>done</internal>', () => {
      expect(prompt).toContain('<internal>done</internal>');
    });

    it('handles the "nothing to store" case', () => {
      expect(prompt).toMatch(/nothing to store/i);
    });
  });
}

// --- buildFlushPrompt: context-window reason ---
describe('buildFlushPrompt (context-window, no learningLoop)', () => {
  const prompt = buildFlushPrompt({ reason: 'context-window' });
  validateFlushPrompt(prompt, 'context-window');

  it('mentions context window filling up', () => {
    expect(prompt).toMatch(/context window.*filling/i);
  });

  it('does NOT include skill extraction step', () => {
    expect(prompt).not.toContain('SKILL EXTRACTION');
    expect(prompt).not.toContain('extracted-skills');
  });

  it('starts numbering at 1 for DURABLE FACTS', () => {
    expect(prompt).toContain('1. DURABLE FACTS');
  });
});

// --- buildFlushPrompt: nightly reason ---
describe('buildFlushPrompt (nightly, no learningLoop)', () => {
  const prompt = buildFlushPrompt({ reason: 'nightly' });
  validateFlushPrompt(prompt, 'nightly');

  it('mentions nightly maintenance', () => {
    expect(prompt).toMatch(/[Nn]ightly/i);
  });

  it('does NOT include skill extraction step', () => {
    expect(prompt).not.toContain('SKILL EXTRACTION');
  });
});

// --- buildFlushPrompt: learningLoop = true ---
describe('buildFlushPrompt (learningLoop: true)', () => {
  const prompt = buildFlushPrompt({
    reason: 'context-window',
    learningLoop: true,
  });
  validateFlushPrompt(prompt, 'learningLoop-true');

  it('includes skill extraction step', () => {
    expect(prompt).toContain('SKILL EXTRACTION');
    expect(prompt).toContain('extracted-skills/');
  });

  it('skill extraction is step 1', () => {
    expect(prompt).toContain('1. SKILL EXTRACTION');
  });

  it('DURABLE FACTS is step 2 (shifted)', () => {
    expect(prompt).toContain('2. DURABLE FACTS');
  });

  it('SESSION SUMMARY is step 3 (shifted)', () => {
    expect(prompt).toContain('3. SESSION SUMMARY');
  });

  it('DAILY NOTE is step 4 (shifted)', () => {
    expect(prompt).toContain('4. DAILY NOTE');
  });

  it('caps at 2 skills per flush', () => {
    expect(prompt).toContain('2 skills per flush');
  });

  it('includes frontmatter format instructions', () => {
    expect(prompt).toContain('confidence: high|medium|low');
  });

  it('includes today date in skill frontmatter example', () => {
    expect(prompt).toContain(`extracted: ${today}`);
  });
});

// --- buildFlushPrompt: learningLoop = 'extract-only' ---
describe("buildFlushPrompt (learningLoop: 'extract-only')", () => {
  const prompt = buildFlushPrompt({
    reason: 'nightly',
    learningLoop: 'extract-only',
  });

  it('includes skill extraction step', () => {
    expect(prompt).toContain('SKILL EXTRACTION');
  });

  it('skill extraction is step 1', () => {
    expect(prompt).toContain('1. SKILL EXTRACTION');
  });
});

// --- buildFlushPrompt: learningLoop = false ---
describe('buildFlushPrompt (learningLoop: false)', () => {
  const prompt = buildFlushPrompt({
    reason: 'context-window',
    learningLoop: false,
  });

  it('does NOT include skill extraction step', () => {
    expect(prompt).not.toContain('SKILL EXTRACTION');
  });

  it('starts numbering at 1 for DURABLE FACTS', () => {
    expect(prompt).toContain('1. DURABLE FACTS');
  });
});

// --- Step ordering: skills before memory before compact ---
describe('flush step ordering (learningLoop: true)', () => {
  const prompt = buildFlushPrompt({
    reason: 'context-window',
    learningLoop: true,
  });

  it('skill extraction appears before DURABLE FACTS', () => {
    const skillIdx = prompt.indexOf('SKILL EXTRACTION');
    const memoryIdx = prompt.indexOf('DURABLE FACTS');
    expect(skillIdx).toBeLessThan(memoryIdx);
  });

  it('DURABLE FACTS appears before SESSION SUMMARY', () => {
    const memoryIdx = prompt.indexOf('DURABLE FACTS');
    const compactIdx = prompt.indexOf('SESSION SUMMARY');
    expect(memoryIdx).toBeLessThan(compactIdx);
  });

  it('SESSION SUMMARY appears before DAILY NOTE', () => {
    const compactIdx = prompt.indexOf('SESSION SUMMARY');
    const dailyIdx = prompt.indexOf('DAILY NOTE');
    expect(compactIdx).toBeLessThan(dailyIdx);
  });
});

// --- getNightlyFlushPrompt delegates to buildFlushPrompt ---
describe('getNightlyFlushPrompt (thin wrapper)', () => {
  it('returns nightly prompt without skills when no arg', () => {
    const prompt = getNightlyFlushPrompt();
    expect(prompt).toMatch(/[Nn]ightly/i);
    expect(prompt).not.toContain('SKILL EXTRACTION');
  });

  it('returns nightly prompt with skills when learningLoop=true', () => {
    const prompt = getNightlyFlushPrompt(true);
    expect(prompt).toMatch(/[Nn]ightly/i);
    expect(prompt).toContain('SKILL EXTRACTION');
  });

  it('returns nightly prompt with skills when learningLoop="extract-only"', () => {
    const prompt = getNightlyFlushPrompt('extract-only');
    expect(prompt).toContain('SKILL EXTRACTION');
  });
});

// --- Suppression integration test ---
describe('flush prompt suppression behavior', () => {
  const stripInternalTags = (text: string) =>
    text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

  it('agent reply <internal>done</internal> is fully suppressed', () => {
    const agentReply = '<internal>done</internal>';
    expect(stripInternalTags(agentReply)).toBe('');
  });

  it('agent reply with extra text outside internal tags is NOT suppressed', () => {
    const reply = '<internal>done</internal> but also this';
    expect(stripInternalTags(reply)).toBe('but also this');
  });

  it('empty internal tag reply is suppressed', () => {
    expect(stripInternalTags('<internal></internal>')).toBe('');
  });
});
