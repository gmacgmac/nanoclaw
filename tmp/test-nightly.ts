/**
 * Dry-run nightly maintenance — outputs the state of all groups
 * without actually triggering any nudges or modifying anything.
 *
 * Usage: npx tsx tmp/test-nightly.ts
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, NIGHTLY_NUDGE_THRESHOLD } from '../src/config.js';
import { getAllRegisteredGroups, getAllSessions, initDatabase } from '../src/db.js';
import { resolveGroupFolderPath } from '../src/group-folder.js';
import { getNightlyNudgePrompt } from '../src/lib/nudge-prompt.js';
import { parseLastInputTokens, runNightlyMaintenance } from '../src/nightly-maintenance.js';

const DEFAULT_CONTEXT_WINDOW = 128000;

// --- Init ---
initDatabase();

const groups = getAllRegisteredGroups();
const sessions = getAllSessions();

console.log('═══════════════════════════════════════════════════');
console.log(' NIGHTLY MAINTENANCE — DRY RUN');
console.log('═══════════════════════════════════════════════════');
console.log(`  Groups registered: ${Object.keys(groups).length}`);
console.log(`  Active sessions:   ${Object.keys(sessions).length}`);
console.log(`  Nudge threshold:   ${(NIGHTLY_NUDGE_THRESHOLD * 100).toFixed(0)}%`);
console.log('');

// --- Per-group state ---
console.log('─── GROUP STATE ───────────────────────────────────');
for (const [jid, group] of Object.entries(groups)) {
  const hasSession = !!sessions[group.folder];
  const contextWindowSize = group.containerConfig?.contextWindowSize || DEFAULT_CONTEXT_WINDOW;
  const lastTokens = parseLastInputTokens(group.folder);
  const usage = lastTokens > 0 ? lastTokens / contextWindowSize : 0;
  const aboveThreshold = usage >= NIGHTLY_NUDGE_THRESHOLD;
  const learningLoop = group.containerConfig?.learningLoop;

  // Check if token-usage.log exists
  let logExists = false;
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    logExists = fs.existsSync(path.join(groupDir, 'token-usage.log'));
  } catch { /* invalid folder */ }

  // Check session in DB
  const sessionId = sessions[group.folder] || null;

  console.log(`\n  📁 ${group.folder} (${group.name})`);
  console.log(`     JID:              ${jid}`);
  console.log(`     Session:          ${hasSession ? `✓ (${sessionId})` : '✗ none'}`);
  console.log(`     token-usage.log:  ${logExists ? '✓ exists' : '✗ missing'}`);
  console.log(`     Last input_tokens: ${lastTokens || 'n/a'}`);
  console.log(`     Context window:   ${contextWindowSize.toLocaleString()}`);
  console.log(`     Usage:            ${(usage * 100).toFixed(1)}%`);
  console.log(`     Above 50%:        ${aboveThreshold ? '⚠️  YES → would be nudged' : '✓ no'}`);
  console.log(`     learningLoop:     ${learningLoop ?? 'not set'}`);

  if (aboveThreshold && hasSession) {
    console.log(`     ┗━ Nudge prompt would include skill extraction: ${learningLoop ? 'YES' : 'no'}`);
  }
  if (!hasSession) {
    console.log(`     ┗━ Skipped: no active session`);
  }
}

// --- Run the actual function with a dry-run nudge ---
console.log('\n─── DRY RUN EXECUTION ─────────────────────────────');

const nudgeLog: string[] = [];

const result = await runNightlyMaintenance({
  runNudge: async (group, chatJid) => {
    const learningLoop = group.containerConfig?.learningLoop;
    const prompt = getNightlyNudgePrompt(learningLoop);
    const hasSkillExtraction = prompt.includes('SKILL EXTRACTION');
    nudgeLog.push(
      `  → Would nudge: ${group.folder} (jid: ${chatJid})` +
      `${hasSkillExtraction ? ' [+skill extraction]' : ''}`
    );
    return true;
  },
  getGroups: () => groups,
  getSessions: () => sessions,
});

if (nudgeLog.length > 0) {
  for (const line of nudgeLog) console.log(line);
} else {
  console.log('  (no groups qualified for nudge)');
}

console.log('\n─── RESULT ────────────────────────────────────────');
console.log(`  Groups checked:  ${result.groupsChecked}`);
console.log(`  Groups nudged:   ${result.groupsNudged.length}`);
if (result.groupsNudged.length > 0) {
  console.log(`  Nudged folders:  ${result.groupsNudged.join(', ')}`);
}

// --- Session persistence check ---
console.log('\n─── SESSION PERSISTENCE CHECK ─────────────────────');
const sessionsAfter = getAllSessions();
for (const folder of result.groupsNudged) {
  const stillExists = !!sessionsAfter[folder];
  console.log(`  ${folder}: session ${stillExists ? '✓ still exists (correct)' : '✗ DELETED (BUG!)'}`);
}
if (result.groupsNudged.length === 0) {
  console.log('  (no nudged groups to check)');
}

console.log('\n═══════════════════════════════════════════════════');
console.log(' Done. No changes were made.');
console.log('═══════════════════════════════════════════════════\n');
