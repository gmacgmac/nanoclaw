/**
 * Shared flush prompt builder — single source of truth for both
 * context-window (agent-runner) and nightly (host-side) flushes.
 *
 * Copied to container/agent-runner/src/lib/flush-prompt.ts at build time
 * (same pattern as SSRF validator in BE_02).
 */

export interface FlushPromptOptions {
  reason: 'context-window' | 'nightly';
  learningLoop?: boolean | 'extract-only';
}

export function buildFlushPrompt(options: FlushPromptOptions): string {
  const today = new Date().toISOString().split('T')[0];

  const openingLine =
    options.reason === 'context-window'
      ? 'MEMORY FLUSH — context window is filling up. Perform these steps now:'
      : 'NIGHTLY MAINTENANCE FLUSH — proactive context preservation.';

  const lines: string[] = [
    '<internal>',
    openingLine,
    '',
    'IMPORTANT: Use ONLY file tools (Read, Write, Edit). Do NOT call manual_flush, send_message, schedule_task, or any MCP tools. Do NOT call any tools starting with mcp__.',
    '',
  ];

  let stepNum = 1;

  // --- Skill extraction (conditional) ---
  if (options.learningLoop) {
    lines.push(
      `${stepNum}. SKILL EXTRACTION → extracted-skills/[skill-name].md`,
      '   - Review this session for reusable patterns: workflows, command sequences, decision frameworks, tool usage patterns',
      '   - Write each skill as a Markdown file with YAML frontmatter:',
      '     ---',
      '     name: [skill-name]',
      `     extracted: ${today}`,
      '     confidence: high|medium|low',
      '     ---',
      '   - Include sections: When to Use, Pattern, Example, Notes',
      '   - Cap at 2 skills per flush — only extract genuinely reusable patterns',
      '   - Skip if this session had no meaningful work (just greetings or trivial exchanges)',
      '   - Create the extracted-skills/ directory if it does not exist',
      '',
    );
    stepNum++;
  }

  // --- Durable facts ---
  lines.push(
    `${stepNum}. DURABLE FACTS → memory/MEMORY.md`,
    '   - Read the current memory/MEMORY.md',
    '   - Append any NEW facts learned in this conversation (names, preferences, decisions, relationships, project context)',
    '   - Remove any facts that have been superseded by newer information',
    '   - Keep it concise — one bullet point per fact, no prose',
    '   - Do NOT duplicate facts already present',
    '',
  );
  stepNum++;

  // --- Session summary ---
  lines.push(
    `${stepNum}. SESSION SUMMARY → memory/COMPACT.md`,
    '   - Write a compact summary of what was discussed and worked on in this session',
    '   - Include any in-progress tasks, pending questions, or agreed next steps',
    '   - Include enough context that the next session feels like a seamless continuation',
    '   - Cap at ~2000 words — this is a bridge, not a transcript',
    '   - Write as a fresh file (overwrite if it exists)',
    '',
  );
  stepNum++;

  // --- Daily note ---
  lines.push(
    `${stepNum}. DAILY NOTE → memory/${today}.md`,
    '   - Append any notable observations or task progress from today to the daily note',
    '   - Create the file if it does not exist',
    '',
    'When finished (or if there is nothing to store), reply with exactly:',
    '<internal>done</internal>',
    '</internal>',
  );

  return lines.join('\n');
}
