/**
 * Post-turn checks — runs after each runQuery() completion.
 * Encapsulates all post-turn health checks in one place:
 *   1. Silent turn detection (no output produced)
 *   2. Degenerate content detection + JSONL cleanup
 *
 * Adding a new check? Add it to runPostTurnChecks() below.
 */

import fs from 'fs';
import path from 'path';

import { isDegenerate } from './degenerate-detector.js';

const SESSION_BASE = '/home/node/.claude/projects/-workspace-group';

interface PostTurnContext {
  sessionId: string | undefined;
  resultCount: number;
  closedDuringQuery: boolean;
  chatJid: string;
  groupFolder: string;
  isScheduledTask?: boolean;
}

interface PostTurnResult {
  silentTurn: boolean;
  degenerateDetected: boolean;
  degenerateChars?: number;
  degenerateEntropy?: number;
}

/**
 * Write a status message to the IPC messages directory.
 * Duplicated here to avoid circular imports with index.ts.
 */
function notify(text: string, chatJid: string, groupFolder: string): void {
  const dir = '/workspace/ipc/messages';
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const data = { type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString() };
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);
}

function log(message: string): void {
  console.error(`[post-turn] ${message}`);
}

/**
 * Check 1: Silent turn — model completed but produced no output.
 */
function checkSilentTurn(ctx: PostTurnContext): boolean {
  if (ctx.closedDuringQuery) return false;
  if (ctx.resultCount > 0) return false;

  log('Silent turn detected — agent produced no output');
  notify(
    '⚠️ No response — the model completed without producing output. Send your message again to retry.',
    ctx.chatJid,
    ctx.groupFolder,
  );
  return true;
}

/**
 * Check 2: Degenerate content — scan last assistant thinking block.
 * If degenerate: log forensics, strip thinking from JSONL, notify group.
 */
function checkDegenerateContent(ctx: PostTurnContext): boolean {
  if (!ctx.sessionId) return false;

  const jsonlPath = path.join(SESSION_BASE, `${ctx.sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return false;

  // Read last few lines to find the last assistant entry with thinking content.
  // Read from end to avoid loading the entire file for large sessions.
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Scan backwards for the last assistant entry with thinking content
  let targetLineIdx = -1;
  let thinkingText = '';

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      const thinkingBlock = content.find(
        (b: { type: string; thinking?: string }) => b.type === 'thinking' && b.thinking,
      );
      if (thinkingBlock) {
        targetLineIdx = i;
        thinkingText = thinkingBlock.thinking;
        break;
      }
    } catch {
      continue;
    }
  }

  if (targetLineIdx === -1 || !thinkingText) return false;

  const result = isDegenerate(thinkingText);
  if (!result.degenerate) return false;

  log(`Degenerate content detected: ${thinkingText.length} chars, entropy=${result.entropy?.toFixed(2)}, ngramRatio=${result.topNgramRatio?.toFixed(2)}`);

  // --- Forensic log ---
  const logDir = '/workspace/group/logs';
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `degenerate-${ts}.log`);
  fs.writeFileSync(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    lineIndex: targetLineIdx,
    contentLength: thinkingText.length,
    entropy: result.entropy,
    topNgramRatio: result.topNgramRatio,
    sample: thinkingText.slice(0, 500),
    fullContent: thinkingText,
  }, null, 2));
  log(`Forensic log written: ${logFile}`);

  // --- Strip thinking block from JSONL entry ---
  try {
    const entry = JSON.parse(lines[targetLineIdx]);
    const content = entry.message.content;
    entry.message.content = content.filter(
      (b: { type: string }) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
    );
    lines[targetLineIdx] = JSON.stringify(entry);

    // Atomic write
    const tempPath = `${jsonlPath}.postcheck`;
    fs.writeFileSync(tempPath, lines.join('\n') + '\n');
    fs.renameSync(tempPath, jsonlPath);
    log('Degenerate thinking block stripped from JSONL');
  } catch (err) {
    log(`Failed to strip degenerate content: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Notify group ---
  notify(
    '⚠️ Corrupted output detected and cleaned. Session continues normally.',
    ctx.chatJid,
    ctx.groupFolder,
  );

  return true;
}

/**
 * Run all post-turn checks. Called from main() after each runQuery() completion.
 * Returns a summary of what was detected.
 */
export function runPostTurnChecks(ctx: PostTurnContext): PostTurnResult {
  const silentTurn = checkSilentTurn(ctx);

  // Skip degenerate check for scheduled tasks (they often have minimal output)
  const degenerateDetected = !ctx.isScheduledTask && checkDegenerateContent(ctx);

  return { silentTurn, degenerateDetected };
}
