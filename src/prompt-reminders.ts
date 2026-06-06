/**
 * Prompt Reminders — file-driven reminder snippets injected per-turn via
 * the UserPromptSubmit hook. Mirrors the load/validate/resolve pattern of presets.ts.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// --- Frontmatter parser (inline, mirrors skill-manager.ts pattern) ---

interface ReminderFrontmatter {
  description?: string;
  requires?: string;
}

function parseFrontmatter(content: string): { fm: ReminderFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { fm: {}, body: content.trim() };

  const fm: ReminderFrontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'description') fm.description = value;
    if (key === 'requires') fm.requires = value;
  }

  const body = content.slice(match[0].length).trim();
  return { fm, body };
}

// --- JID → Channel mapping (single source of truth) ---

/**
 * Derive the human-readable channel name from a chat JID.
 * Returns null for unrecognised JID formats.
 */
export function channelFromJid(jid: string): string | null {
  if (jid.startsWith('tg:')) return 'Telegram';
  if (jid.startsWith('slack:')) return 'Slack';
  if (jid.startsWith('dc:')) return 'Discord';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) return 'WhatsApp';
  return null;
}

// --- Resolver ---

const HOOKS_DIR = path.resolve(process.cwd(), 'docs', 'hooks');

/**
 * Resolve an ordered list of reminder keys into a single prompt string.
 * Skips missing files (warns) and entries that require channel when channel is null.
 * Returns '' if nothing resolved.
 */
export function resolveReminders(keys: string[], channel: string | null): string {
  if (keys.length === 0) return '';

  const parts: string[] = [];

  for (const key of keys) {
    const filePath = path.join(HOOKS_DIR, `${key}.md`);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      logger.warn({ key, path: filePath }, 'Reminder hook file not found — skipping');
      continue;
    }

    const { fm, body } = parseFrontmatter(raw);

    // Skip if this snippet requires channel and channel is unknown
    if (fm.requires === 'channel' && !channel) continue;

    if (!body) continue;

    // Interpolate {channel} placeholder
    const resolved = body.replace(/\{channel\}/g, channel ?? '');
    parts.push(resolved);
  }

  return parts.join('\n');
}
