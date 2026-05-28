/**
 * Nudge prompt builder for container-side memory maintenance.
 *
 * Supports two trigger reasons:
 *   - periodic: every 10 turns
 *   - threshold: 80% context window capacity
 *
 * Unlike the old flush prompt, the nudge does NOT write COMPACT.md,
 * does NOT signal completion, and does NOT trigger session deletion.
 */

export interface NudgePromptOptions {
  reason: 'periodic' | 'threshold';
}

export function buildNudgePrompt(options: NudgePromptOptions): string {
  const today = new Date().toISOString().split('T')[0];

  const openingLines: Record<NudgePromptOptions['reason'], string> = {
    periodic:
      'MEMORY NUDGE — periodic checkpoint. Review recent conversation and persist anything important.',
    threshold:
      'MEMORY NUDGE — urgent checkpoint. Review recent conversation and persist anything important.',
  };

  const lines: string[] = [
    '<internal>',
    openingLines[options.reason],
    '',
    'IMPORTANT: Use ONLY file tools (Read, Write, Edit). Do NOT call send_message, schedule_task, or any MCP tools. Do NOT call any tools starting with mcp__.',
    '',
  ];

  // --- Step 1: Durable facts ---
  lines.push(
    '1. DURABLE FACTS → memory/MEMORY.md',
    '   - Read the current memory/MEMORY.md',
    '   - Append any NEW facts learned in this conversation (preferences, decisions, corrections, project context)',
    '   - Remove any facts that have been superseded by newer information',
    '   - Keep it concise — one bullet point per fact, no prose',
    '   - MEMORY.md must stay under 5000 characters. If approaching capacity, consolidate related facts into fewer entries. Remove stale or superseded facts.',
    '   - Do NOT duplicate facts already present',
    '',
  );

  // --- Step 2: Daily note ---
  lines.push(
    `2. DAILY NOTE → memory/${today}.md`,
    '   - Append any notable observations or task progress from today to the daily note',
    '   - Create the file if it does not exist',
    '',
  );

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
