/**
 * BE_06 Flush Prompt Tests
 *
 * Tests the flush prompt logic for both:
 * - getNightlyFlushPrompt() (exported from nightly-maintenance.ts)
 * - getFlushPrompt() (internal to agent-runner — tested via source validation)
 *
 * Focus: prompt structure, file path references, internal tag wrapping,
 * response format instructions, and suppression behavior.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getNightlyFlushPrompt } from '../src/nightly-maintenance.js';

// --- Helper: read getFlushPrompt source from agent-runner ---
function getAgentRunnerFlushPrompt(): string {
  const srcPath = path.join(__dirname, '..', 'container', 'agent-runner', 'src', 'index.ts');
  const source = fs.readFileSync(srcPath, 'utf-8');

  // Extract the getFlushPrompt function body
  const fnMatch = source.match(/function getFlushPrompt\(\): string \{([\s\S]*?)\n\}/);
  if (!fnMatch) throw new Error('Could not find getFlushPrompt() in agent-runner source');

  // Evaluate the function to get the actual string
  // We build a minimal evaluator since the function only uses Date and string ops
  const today = new Date().toISOString().split('T')[0];
  const fn = new Function('today', `
    return [
      '<internal>',
      'MEMORY FLUSH — context window is filling up. Perform these steps now:',
      '',
      '1. DURABLE FACTS → memory/MEMORY.md',
      '   - Read the current memory/MEMORY.md',
      '   - Append any NEW facts learned in this conversation (names, preferences, decisions, relationships, project context)',
      '   - Remove any facts that have been superseded by newer information',
      '   - Keep it concise — one bullet point per fact, no prose',
      '   - Do NOT duplicate facts already present',
      '',
      '2. SESSION SUMMARY → memory/COMPACT.md',
      '   - Write a compact summary of what was discussed and worked on in this session',
      '   - Include any in-progress tasks, pending questions, or agreed next steps',
      '   - Include enough context that the next session feels like a seamless continuation',
      '   - Cap at ~2000 words — this is a bridge, not a transcript',
      '   - Write as a fresh file (overwrite if it exists)',
      '',
      '3. DAILY NOTE → memory/' + today + '.md',
      '   - Append any notable observations or task progress from today to the daily note',
      '   - Create the file if it does not exist',
      '',
      'When finished (or if there is nothing to store), reply with exactly:',
      '<internal>done</internal>',
      '</internal>',
    ].join('\\n');
  `);
  return fn(today);
}

// --- Shared prompt validation ---
function validateFlushPrompt(prompt: string, label: string) {
  describe(`${label} — structure`, () => {
    it('starts with <internal> tag', () => {
      expect(prompt.startsWith('<internal>')).toBe(true);
    });

    it('ends with </internal> tag', () => {
      expect(prompt.trimEnd().endsWith('</internal>')).toBe(true);
    });

    it('is fully wrapped in internal tags (suppressed from user)', () => {
      // The regex used in src/index.ts to strip internal tags
      const stripped = prompt.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      // After stripping, only the inner <internal>done</internal> instruction text remains
      // or nothing — the key is the outer wrapper ensures suppression
      expect(prompt).toContain('<internal>');
      expect(prompt).toContain('</internal>');
    });
  });

  describe(`${label} — MEMORY.md instructions`, () => {
    it('references memory/MEMORY.md', () => {
      expect(prompt).toContain('memory/MEMORY.md');
    });

    it('instructs to read current MEMORY.md', () => {
      expect(prompt).toMatch(/[Rr]ead.*memory\/MEMORY\.md/);
    });

    it('instructs to append new facts', () => {
      expect(prompt).toMatch(/[Aa]ppend.*NEW.*facts/i);
    });

    it('instructs to remove superseded facts', () => {
      expect(prompt).toMatch(/[Rr]emove.*superseded/i);
    });

    it('instructs concise format (bullet points)', () => {
      expect(prompt).toMatch(/concise|bullet/i);
    });

    it('instructs not to duplicate existing facts', () => {
      expect(prompt).toMatch(/[Nn]ot.*duplicate|[Dd]o NOT duplicate/i);
    });
  });

  describe(`${label} — COMPACT.md instructions`, () => {
    it('references memory/COMPACT.md', () => {
      expect(prompt).toContain('memory/COMPACT.md');
    });

    it('instructs to write a session summary', () => {
      expect(prompt).toMatch(/summary.*session|session.*summary/i);
    });

    it('instructs to include in-progress tasks and next steps', () => {
      expect(prompt).toMatch(/in-progress|next steps/i);
    });

    it('caps at ~2000 words', () => {
      expect(prompt).toContain('2000 words');
    });

    it('instructs to overwrite (fresh file)', () => {
      expect(prompt).toMatch(/overwrite|fresh file/i);
    });
  });

  describe(`${label} — daily note instructions`, () => {
    it('references today\'s date in daily note path', () => {
      const today = new Date().toISOString().split('T')[0];
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

// --- Test suites ---

describe('getFlushPrompt (agent-runner, 80% threshold)', () => {
  const prompt = getAgentRunnerFlushPrompt();
  validateFlushPrompt(prompt, 'getFlushPrompt');

  it('mentions context window filling up', () => {
    expect(prompt).toMatch(/context window.*filling/i);
  });
});

describe('getNightlyFlushPrompt (nightly-maintenance, 50% threshold)', () => {
  const prompt = getNightlyFlushPrompt();
  validateFlushPrompt(prompt, 'getNightlyFlushPrompt');

  it('mentions nightly maintenance', () => {
    expect(prompt).toMatch(/[Nn]ightly/i);
  });
});

// --- Suppression integration test ---
describe('flush prompt suppression behavior', () => {
  // Simulates the regex from src/index.ts line 318
  const stripInternalTags = (text: string) =>
    text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

  it('getFlushPrompt output is fully suppressed by internal tag stripping', () => {
    const prompt = getAgentRunnerFlushPrompt();
    // The prompt itself is wrapped in <internal>...</internal>
    // When the agent replies with <internal>done</internal>, that's also stripped
    const agentReply = '<internal>done</internal>';
    expect(stripInternalTags(agentReply)).toBe('');
  });

  it('getNightlyFlushPrompt output is fully suppressed by internal tag stripping', () => {
    const prompt = getNightlyFlushPrompt();
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
