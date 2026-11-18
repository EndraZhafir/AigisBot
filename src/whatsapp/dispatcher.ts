import { delay, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';

export interface ReplyOptions {
  readonly typingDelayMs?: number;
}

/**
 * Simulates human-like typing presence before sending a quoted reply to a group message.
 */
export async function sendQuotedReply(
  sock: WASocket,
  groupJid: string,
  text: string,
  quotedMessage: WAMessage,
  logger: Logger,
  options: ReplyOptions = {},
): Promise<WAMessage | undefined> {
  const typingDelayMs = options.typingDelayMs ?? 1_000;

  try {
    await sock.presenceSubscribe(groupJid);
    await sock.sendPresenceUpdate('composing', groupJid);
    await delay(typingDelayMs);
  } catch (err) {
    logger.debug({ err, groupJid }, 'Failed to update typing presence; continuing with reply.');
  }

  try {
    return await sock.sendMessage(groupJid, { text, linkPreview: null }, { quoted: quotedMessage });
  } finally {
    try {
      await sock.sendPresenceUpdate('paused', groupJid);
    } catch {
      // Ignore post-send presence cleanup failures.
    }
  }
}

/**
 * Sends a lightweight emoji reaction (e.g. "⏳") to indicate rate-limiting without text spam.
 */
export async function sendCooldownReaction(
  sock: WASocket,
  groupJid: string,
  targetMessage: WAMessage,
  emoji: string,
  logger: Logger,
): Promise<void> {
  if (!emoji || !targetMessage.key?.id) {
    return;
  }

  try {
    await sock.sendMessage(groupJid, {
      react: {
        text: emoji,
        key: targetMessage.key,
      },
    });
  } catch (err) {
    logger.debug({ err, groupJid, emoji }, 'Failed to send cooldown emoji reaction.');
  }
}
