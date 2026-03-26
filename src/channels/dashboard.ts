import { ASSISTANT_NAME } from '../config.js';
import { storeMessageDirect, storeChatMetadata } from '../db.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import type { Channel } from '../types.js';

/**
 * Dashboard channel for internal web chat.
 *
 * Claims JIDs ending with @internal and stores messages in the database
 * for the dashboard to poll. No external platform connection needed.
 */
export class DashboardChannel implements Channel {
  name = 'dashboard';

  async connect(): Promise<void> {
    // Ensure the chat row exists so foreign key constraints are satisfied
    storeChatMetadata(
      'dashboard@internal',
      new Date().toISOString(),
      'Dashboard',
      'dashboard',
      false,
    );
    logger.info('Dashboard channel ready');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Store the bot response in DB so dashboard can poll for it
    storeMessageDirect({
      id: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
    logger.debug({ jid }, 'Dashboard channel: stored bot response');
  }

  isConnected(): boolean {
    return true; // Always available
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@internal');
  }

  async disconnect(): Promise<void> {
    // No-op
  }
}

// Self-register on import
registerChannel('dashboard', () => new DashboardChannel());
