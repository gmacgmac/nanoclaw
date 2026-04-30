import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getSession } from './db.js';
import { logger } from './logger.js';

const SANITIZE_RE = /[^a-zA-Z0-9-]/g;

function sanitizeId(id: string): string {
  return id.replace(SANITIZE_RE, '-');
}

/**
 * Sanitize tool_use and tool_result IDs in a group's session JSONL file.
 * Uses a two-pass approach:
 *   1. Build a Map of original → sanitized IDs from all tool_use blocks.
 *   2. Replace IDs in all tool_use and tool_result blocks using the Map.
 *
 * Preserves file atomically (write to temp, then rename).
 * Returns silently if the file does not exist.
 * Throws on parse or I/O errors so the caller can decide whether to proceed.
 */
export function sanitizeSessionJsonl(groupFolder: string): void {
  const sessionId = getSession(groupFolder);
  if (!sessionId) {
    // No session yet — nothing to sanitize
    return;
  }

  const filePath = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );

  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  // Parse all lines into objects
  const entries: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      logger.warn(
        { filePath, line: i + 1 },
        'Skipping unparseable JSONL line during sanitization',
      );
      // Keep the raw line to preserve it unchanged
      entries.push(lines[i]);
    }
  }

  // --- Pass 1: Build original → sanitized mapping from tool_use blocks ---
  const idMap = new Map<string, string>();
  const seenSanitized = new Set<string>();
  let hasToolBlocks = false;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const message =
      typeof e.message === 'object' && e.message !== null
        ? (e.message as Record<string, unknown>)
        : null;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' || b.type === 'tool_result') {
        hasToolBlocks = true;
      }
      if (
        b.type === 'tool_use' &&
        typeof b.id === 'string'
      ) {
        const originalId = b.id;
        if (!idMap.has(originalId)) {
          let sanitized = sanitizeId(originalId);
          // Handle collision: append counter until unique
          let counter = 2;
          while (seenSanitized.has(sanitized)) {
            sanitized = `${sanitizeId(originalId)}-${counter}`;
            counter++;
          }
          seenSanitized.add(sanitized);
          idMap.set(originalId, sanitized);
        }
      }
    }
  }

  // --- Pass 2: Strip thinking blocks (model-specific signatures break cross-model resume) ---
  let hasThinkingBlocks = false;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const message =
      typeof e.message === 'object' && e.message !== null
        ? (e.message as Record<string, unknown>)
        : null;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    const filtered = content.filter((block) => {
      if (typeof block !== 'object' || block === null) return true;
      const b = block as Record<string, unknown>;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        hasThinkingBlocks = true;
        return false;
      }
      return true;
    });

    if (filtered.length !== content.length) {
      (message as Record<string, unknown>).content = filtered;
    }
  }

  if (!hasToolBlocks && !hasThinkingBlocks) {
    return;
  }

  // --- Pass 3: Apply mapping to tool_use.id and tool_result.tool_use_id ---
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const message =
      typeof e.message === 'object' && e.message !== null
        ? (e.message as Record<string, unknown>)
        : null;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const mapped = idMap.get(b.id);
        if (mapped) {
          b.id = mapped;
        }
      }

      if (
        b.type === 'tool_result' &&
        typeof b.tool_use_id === 'string'
      ) {
        const mapped = idMap.get(b.tool_use_id);
        if (mapped) {
          b.tool_use_id = mapped;
        } else {
          // Orphan tool_result: sanitize in-place, log warning
          const sanitized = sanitizeId(b.tool_use_id);
          logger.warn(
            { filePath, orphanId: b.tool_use_id, sanitized },
            'tool_result references unknown tool_use id — sanitizing in place',
          );
          b.tool_use_id = sanitized;
        }
      }
    }
  }

  // --- Write atomically ---
  const serialized = entries
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('\n');
  const tempPath = `${filePath}.sanitize`;
  fs.writeFileSync(tempPath, serialized + '\n');
  fs.renameSync(tempPath, filePath);

  logger.info(
    { filePath, idsSanitized: idMap.size },
    'Session JSONL sanitized',
  );
}
