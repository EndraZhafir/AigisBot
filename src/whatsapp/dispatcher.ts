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
