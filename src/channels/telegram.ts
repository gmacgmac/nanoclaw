import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Parse a Telegram JID string into its components.
 *
 *   tg:123456       → { chatId: '123456' }
 *   tg:123456:choc  → { chatId: '123456', botName: 'choc' }
 */
export function parseTelegramJid(jid: string): { chatId: string; botName?: string } {
  const withoutPrefix = jid.replace(/^tg:/, '');
  const colonIdx = withoutPrefix.indexOf(':');
  if (colonIdx === -1) {
    return { chatId: withoutPrefix };
  }
  return {
    chatId: withoutPrefix.slice(0, colonIdx),
    botName: withoutPrefix.slice(colonIdx + 1),
  };
}

/**
 * Build a Telegram JID from a chat ID and bot name.
 *
 *   makeJid(123456, 'default') → 'tg:123456'
 *   makeJid(123456, 'choc')    → 'tg:123456:choc'
 */
export function makeJid(chatId: number | string, botName: string): string {
  const id = String(chatId);
  if (!botName || botName === 'default') {
    return `tg:${id}`;
  }
  return `tg:${id}:${botName}`;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Discover all Telegram bot tokens from secrets.env, .env, and process.env.
 * Convention:
 *   TELEGRAM_BOT_TOKEN           → bot name "default"
 *   TELEGRAM_{NAME}_BOT_TOKEN    → bot name "{lowercase-name}"
 *
 * Returns a map of bot name → token.
 */
function discoverBotTokens(): Record<string, string> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const secretsFile = path.join(homeDir, '.config', 'nanoclaw', 'secrets.env');
  const envFile = path.join(process.cwd(), '.env');

  // Collect all key=value pairs from env files
  const allVars: Record<string, string> = {};
  for (const filePath of [secretsFile, envFile]) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (value) allVars[key] = value;
    }
  }

  // Also check process.env
  for (const key of Object.keys(process.env)) {
    if (key === 'TELEGRAM_BOT_TOKEN' || /^TELEGRAM_\w+_BOT_TOKEN$/.test(key)) {
      if (!allVars[key] && process.env[key]) {
        allVars[key] = process.env[key]!;
      }
    }
  }

  const tokens: Record<string, string> = {};

  for (const [key, value] of Object.entries(allVars)) {
    if (key === 'TELEGRAM_BOT_TOKEN') {
      tokens['default'] = value;
    } else {
      const match = key.match(/^TELEGRAM_(.+)_BOT_TOKEN$/);
      if (match) {
        tokens[match[1].toLowerCase()] = value;
      }
    }
  }

  return tokens;
}

/**
 * Download a Telegram file and save it to the group's media directory.
 * Returns the local file path, or null if download fails.
 */
async function downloadTelegramFile(
  api: { getFile: Api['getFile'] },
  botToken: string,
  fileId: string,
  groupFolder: string,
  originalName?: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    // Resolve group folder path
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    const mediaDir = path.join(groupDir, 'media');

    // Ensure media directory exists
    await fs.promises.mkdir(mediaDir, { recursive: true });

    // Generate filename with human-readable timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const ext = file.file_path.split('.').pop() || 'bin';
    const baseName = originalName
      ? originalName.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 50)
      : 'attachment';
    const filename = `${timestamp}_${baseName}.${ext}`;
    const filepath = path.join(mediaDir, filename);

    // Download and save
    const response = await fetch(fileUrl);
    if (!response.ok) {
      logger.error(
        { status: response.status },
        'Failed to download Telegram file',
      );
      return null;
    }
    const buffer = await response.arrayBuffer();
    await fs.promises.writeFile(filepath, Buffer.from(buffer));

    logger.info({ filepath, groupFolder }, 'Telegram attachment downloaded');
    return filepath;
  } catch (err) {
    logger.error({ err }, 'Failed to download Telegram file');
    return null;
  }
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots = new Map<string, Bot>();
  private botTokens = new Map<string, string>();
  private opts: TelegramChannelOpts;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
  }

  /**
   * Resolve the correct bot for a given JID.
   *
   * Priority:
   *   1. JID suffix (self-describing, e.g. tg:123:choc)
   *   2. containerConfig.telegramBot (fallback for plain JIDs)
   *   3. 'default'
   */
  private getBotForJid(
    jid: string,
  ): { bot: Bot; token: string; name: string } | null {
    const parsed = parseTelegramJid(jid);
    const configBot =
      this.opts.registeredGroups()[jid]?.containerConfig?.telegramBot?.toLowerCase();

    // Prefer JID suffix, fall back to containerConfig
    let botName: string;
    if (parsed.botName) {
      botName = parsed.botName.toLowerCase();
      if (configBot && configBot !== botName) {
        logger.warn(
          { jid, jidBot: botName, configBot },
          'JID suffix and containerConfig.telegramBot disagree; using JID suffix',
        );
      }
    } else {
      botName = configBot || 'default';
    }

    const bot = this.bots.get(botName) || this.bots.get('default');
    const name = this.bots.has(botName) ? botName : 'default';
    if (!bot) return null;
    return { bot, token: this.botTokens.get(name) || '', name };
  }

  async connect(): Promise<void> {
    const tokens = discoverBotTokens();
    const entries = Object.entries(tokens);

    if (entries.length === 0) {
      logger.warn('Telegram: no TELEGRAM_*_BOT_TOKEN env vars found');
      return;
    }

    logger.info(
      { count: entries.length, names: entries.map(([n]) => n) },
      'Discovered Telegram bot tokens',
    );

    const startPromises: Promise<void>[] = [];

    for (const [botName, token] of entries) {
      const bot = new Bot(token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });
      this.bots.set(botName, bot);
      this.botTokens.set(botName, token);

      // --- Attach handlers to this bot instance ---

      // Command to get chat ID (useful for registration)
      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        const chatName =
          chatType === 'private'
            ? ctx.from?.first_name || 'Private'
            : (ctx.chat as any).title || 'Unknown';
        const virtualJid = makeJid(chatId, botName);

        ctx.reply(
          `Chat ID: \`${virtualJid}\`\nName: ${chatName}\nType: ${chatType}\nBot: ${botName}`,
          { parse_mode: 'Markdown' },
        );
      });

      // Command to check bot status
      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} is online. (bot: ${botName})`);
      });

      // Telegram bot commands handled above — skip them in the general handler
      const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) {
          const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
          if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
        }

        const chatJid = makeJid(ctx.chat.id, botName);
        let content = ctx.message.text;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        const sender = ctx.from?.id.toString() || '';
        const msgId = ctx.message.message_id.toString();

        const chatName =
          ctx.chat.type === 'private'
            ? senderName
            : (ctx.chat as any).title || chatJid;

        // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
        const botUsername = ctx.me?.username?.toLowerCase();
        if (botUsername) {
          const entities = ctx.message.entities || [];
          const isBotMentioned = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = content
                .substring(entity.offset, entity.offset + entity.length)
                .toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          chatName,
          'telegram',
          isGroup,
        );

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Telegram chat',
          );
          return;
        }

        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, chatName, sender: senderName, bot: botName },
          'Telegram message stored',
        );
      });

      // Handle non-text messages with placeholders
      const storeNonText = (ctx: any, placeholder: string) => {
        const chatJid = makeJid(ctx.chat.id, botName);
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `${placeholder}${caption}`,
          timestamp,
          is_from_me: false,
        });
      };

      // Handler for downloadable attachments (photo, video, audio, document)
      const handleAttachment = async (
        ctx: any,
        placeholder: string,
        getFileId: (msg: any) => string | undefined,
        getFileName?: (msg: any) => string | undefined,
      ) => {
        const chatJid = makeJid(ctx.chat.id, botName);
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        const fileId = getFileId(ctx.message);
        if (!fileId) {
          storeNonText(ctx, placeholder);
          return;
        }

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );

        // Download using this bot's api and token
        const filepath = await downloadTelegramFile(
          bot.api,
          token,
          fileId,
          group.folder,
          getFileName?.(ctx.message),
        );

        const content = filepath
          ? `${placeholder}: ${filepath}${caption}`
          : `${placeholder}${caption}`;

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // Photo: get the largest size
      bot.on('message:photo', (ctx) =>
        handleAttachment(
          ctx,
          '[Photo]',
          (msg) => msg.photo?.[msg.photo.length - 1]?.file_id,
        ),
      );

      // Video
      bot.on('message:video', (ctx) =>
        handleAttachment(
          ctx,
          '[Video]',
          (msg) => msg.video?.file_id,
          (msg) => msg.video?.file_name,
        ),
      );

      // Voice message
      bot.on('message:voice', (ctx) =>
        handleAttachment(ctx, '[Voice]', (msg) => msg.voice?.file_id),
      );

      // Audio file
      bot.on('message:audio', (ctx) =>
        handleAttachment(
          ctx,
          '[Audio]',
          (msg) => msg.audio?.file_id,
          (msg) => msg.audio?.file_name || msg.audio?.title,
        ),
      );

      // Document
      bot.on('message:document', (ctx) =>
        handleAttachment(
          ctx,
          '[Document]',
          (msg) => msg.document?.file_id,
          (msg) => msg.document?.file_name,
        ),
      );

      // Sticker (no file download needed)
      bot.on('message:sticker', (ctx) => {
        const emoji = ctx.message.sticker?.emoji || '';
        storeNonText(ctx, `[Sticker ${emoji}]`);
      });

      // Location (no file)
      bot.on('message:location', (ctx) => {
        const lat = ctx.message.location?.latitude;
        const lon = ctx.message.location?.longitude;
        storeNonText(ctx, `[Location: ${lat}, ${lon}]`);
      });

      // Contact (no file)
      bot.on('message:contact', (ctx) => {
        const name = ctx.message.contact?.first_name || '';
        const phone = ctx.message.contact?.phone_number || '';
        storeNonText(ctx, `[Contact: ${name} ${phone}]`);
      });

      // Handle errors gracefully
      bot.catch((err) => {
        logger.error({ err: err.message, bot: botName }, 'Telegram bot error');
      });

      // Start polling
      startPromises.push(
        new Promise<void>((resolve) => {
          bot.start({
            onStart: (botInfo) => {
              logger.info(
                { username: botInfo.username, id: botInfo.id, botName },
                'Telegram bot connected',
              );
              console.log(
                `\n  Telegram bot [${botName}]: @${botInfo.username}`,
              );
              if (botName === 'default') {
                console.log(
                  `  Send /chatid to the bot to get a chat's registration ID\n`,
                );
              }
              resolve();
            },
          });
        }),
      );
    }

    await Promise.all(startPromises);
    if (this.bots.size > 1) {
      console.log(`  ${this.bots.size} Telegram bots connected\n`);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const resolved = this.getBotForJid(jid);
    if (!resolved) {
      logger.warn({ jid }, 'Telegram: no bot available to send message');
      return;
    }

    try {
      const numericId = parseTelegramJid(jid).chatId;

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(resolved.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            resolved.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, bot: resolved.name },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.size > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const [name, bot] of this.bots) {
      bot.stop();
      logger.info({ bot: name }, 'Telegram bot stopped');
    }
    this.bots.clear();
    this.botTokens.clear();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const resolved = this.getBotForJid(jid);
    if (!resolved) return;
    try {
      const numericId = parseTelegramJid(jid).chatId;
      await resolved.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  // Quick check: is there at least one Telegram token available?
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const hasDefault =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';

  // Also check for any TELEGRAM_*_BOT_TOKEN in process.env
  const hasAny =
    hasDefault ||
    Object.keys(process.env).some(
      (k) => /^TELEGRAM_\w+_BOT_TOKEN$/.test(k) && process.env[k],
    );

  if (!hasAny) {
    logger.warn('Telegram: no TELEGRAM_*_BOT_TOKEN env vars found');
    return null;
  }
  return new TelegramChannel(opts);
});
