/**
 * Nudge prompt builder — single source of truth for all memory nudge text.
 *
 * Supports three trigger reasons:
 *   - periodic: every 10 turns
 *   - threshold: 80% context window capacity
 *   - nightly: end-of-day maintenance
 *
 * Unlike the old flush prompt, the nudge does NOT write COMPACT.md,
 * does NOT signal completion, and does NOT trigger session deletion.
 *
 * Copied to repo/src/lib/nudge-prompt.ts for host-side nightly maintenance.
 */

export interface NudgePromptOptions {
  reason: 'periodic' | 'threshold' | 'nightly';
  learningLoop?: boolean | 'extract-only';
}

export function buildNudgePrompt(options: NudgePromptOptions): string {
  const today = new Date().toISOString().split('T')[0];

  const openingLines: Record<NudgePromptOptions['reason'], string> = {
    periodic:
      'MEMORY NUDGE — periodic checkpoint. Review recent conversation and persist anything important.',
    threshold:
      'MEMORY NUDGE — context window reaching capacity. Persist important facts before auto-compaction.',
    nightly: 'NIGHTLY MEMORY NUDGE — end-of-day persistence check.',
  };

  const lines: string[] = [
    '<internal>',
    openingLines[options.reason],
    '',
    'IMPORTANT: Use ONLY file tools (Read, Write, Edit). Do NOT call send_message, schedule_task, or any MCP tools. Do NOT call any tools starting with mcp__.',
    '',
  ];

  let stepNum = 1;

  // --- Step 1: Durable facts (always) ---
  lines.push(
    `${stepNum}. DURABLE FACTS → memory/MEMORY.md`,
    '   - Read the current memory/MEMORY.md',
    '   - Append any NEW facts learned in this conversation (preferences, decisions, corrections, project context)',
    '   - Remove any facts that have been superseded by newer information',
    '   - Keep it concise — one bullet point per fact, no prose',
    '   - MEMORY.md must stay under 5000 characters. If approaching capacity, consolidate related facts into fewer entries. Remove stale or superseded facts.',
    '   - Do NOT duplicate facts already present',
    '',
  );
  stepNum++;

  // --- Step 2: Daily note (always) ---
  lines.push(
    `${stepNum}. DAILY NOTE → memory/${today}.md`,
    '   - Append any notable observations or task progress from today to the daily note',
    '   - Create the file if it does not exist',
    '',
  );
  stepNum++;

  // --- Step 3: Skill extraction (conditional — nightly + learningLoop) ---
  if (options.reason === 'nightly' && options.learningLoop) {
    lines.push(
      `${stepNum}. SKILL EXTRACTION → extracted-skills/[skill-name].md`,
      '   - Review this session for reusable patterns: workflows, command sequences, decision frameworks, tool usage patterns',
      '   - Write each skill as a Markdown file with YAML frontmatter:',
      '     ---',
      '     name: [skill-name]',
      `     extracted: ${today}`,
      '     source_group: [use the value of $NANOCLAW_GROUP_FOLDER env var]',
      '     confidence: high|medium|low',
      '     ---',
      '   - Include sections: When to Use, Pattern, Example, Notes',
      '   - Cap at 2 skills per nudge — only extract genuinely reusable patterns',
      '   - Skip if this session had no meaningful work (just greetings or trivial exchanges)',
      '   - Create the extracted-skills/ directory if it does not exist',
      '',
    );
    stepNum++;
  }

  // --- Closing ---
  lines.push(
    'When finished, continue with your normal work. Do not announce that you performed this maintenance.',
    '</internal>',
  );

  return lines.join('\n');
}

/**
 * Convenience wrapper for nightly maintenance (host-side usage).
 */
export function getNightlyNudgePrompt(
  learningLoop?: boolean | 'extract-only',
): string {
  return buildNudgePrompt({ reason: 'nightly', learningLoop });
}
