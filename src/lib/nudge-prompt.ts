/**
 * Nightly nudge prompt builder for host-side maintenance.
 *
 * Triggered by the nightly maintenance cron job. Spawns a fresh
 * container session for end-of-day persistence and optional skill
 * extraction.
 *
 * Unlike the old flush prompt, the nudge does NOT write COMPACT.md,
 * does NOT signal completion, and does NOT trigger session deletion.
 */

export function getNightlyNudgePrompt(
  learningLoop?: boolean | 'extract-only',
): string {
  const today = new Date().toISOString().split('T')[0];

  const lines: string[] = [
    '<internal>',
    'NIGHTLY MEMORY NUDGE — end-of-day persistence check.',
    '',
    'IMPORTANT: Use ONLY file tools (Read, Write, Edit). Do NOT call send_message, schedule_task, or any MCP tools. Do NOT call any tools starting with mcp__.',
    '',
  ];

  let stepNum = 1;

  // --- Step 1: Durable facts ---
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

  // --- Step 2: Daily note ---
  lines.push(
    `${stepNum}. DAILY NOTE → memory/${today}.md`,
    '   - Append any notable observations or task progress from today to the daily note',
    '   - Create the file if it does not exist',
    '',
  );
  stepNum++;

  // --- Step 3: Skill extraction (conditional) ---
  if (learningLoop) {
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
    'When finished, your ENTIRE response MUST be exactly:',
    '<internal>done</internal>',
    '',
    'Do NOT produce any other text. Do not explain, summarize, announce, or greet. The <internal> wrapper is required so your reply is not delivered to the user.',
    '</internal>',
  );

  return lines.join('\n');
}
