import {
  extractMessageContent,
  isJidGroup,
  isJidStatusBroadcast,
  jidDecode,
  jidNormalizedUser,
  toNumber,
  type WAMessage,
  type WAMessageContent,
  type proto,
} from '@whiskeysockets/baileys';
import type {
  BotIdentity,
  ObservedGroupMessage,
  QuotedMessageContext,
  RouterDecision,
  RouterIgnoreReason,
} from './types.js';

interface ExtractedPayload {
  text: string;
  contextInfo: proto.IContextInfo | undefined;
}

const CONTEXT_CARRIER_KEYS = [
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'audioMessage',
  'stickerMessage',
] as const;

/**
 * Extracts readable text/caption and contextInfo from any normalized WhatsApp message content.
 * Handles disappearing/ephemeral wrappers via Baileys' `extractMessageContent`.
 */
export function extractTextAndContextInfo(
  rawContent: WAMessageContent | null | undefined,
): ExtractedPayload {
  const content = extractMessageContent(rawContent);
  if (!content) {
    return { text: '', contextInfo: undefined };
  }

  let contextInfo: proto.IContextInfo | undefined;
  let caption = '';

  for (const key of CONTEXT_CARRIER_KEYS) {
    const part = content[key];
    if (!part) {
      continue;
    }

    contextInfo ??= part.contextInfo ?? undefined;
    if (!caption && 'caption' in part && typeof part.caption === 'string') {
      caption = part.caption;
    }
  }

  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    caption;

  return {
    text: text.trim(),
    contextInfo,
  };
}

/**
 * Checks whether a candidate JID belongs to the bot (either by Phone JID or Linked ID).
 * Comparing decoded `user` parts safely matches `@s.whatsapp.net`, `@lid`, `@hosted`, and device JIDs.
 */
export function isBotJid(candidateJid: string | null | undefined, identity: BotIdentity): boolean {
  if (!candidateJid) {
    return false;
  }

  const normalizedCandidate = jidNormalizedUser(candidateJid);
  const candidateUser = jidDecode(normalizedCandidate)?.user;

  const knownJids = [identity.phoneJid, identity.lidJid].filter(
    (jid): jid is string => Boolean(jid),
  );

  for (const botJid of knownJids) {
    const normalizedBot = jidNormalizedUser(botJid);
    if (normalizedCandidate === normalizedBot) {
      return true;
    }

    const botUser = jidDecode(normalizedBot)?.user;
    if (candidateUser && botUser && candidateUser === botUser) {
      return true;
    }
  }

  return false;
}

/**
 * Strips `@<botPhoneUser>` or `@<botLidUser>` mention tokens from a message string.
 */
export function stripBotMentionTokens(text: string, identity: BotIdentity): string {
  const botUsers = [identity.phoneJid, identity.lidJid]
    .map((jid) => (jid ? jidDecode(jidNormalizedUser(jid))?.user : undefined))
    .filter((user): user is string => Boolean(user));

  let cleaned = text;
  for (const user of botUsers) {
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`@${escaped}\\b`, 'g'), '');
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractQuotedContext(
  contextInfo: proto.IContextInfo | undefined,
): QuotedMessageContext | undefined {
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }

  const quotedPayload = extractTextAndContextInfo(contextInfo.quotedMessage);
  if (!quotedPayload.text) {
    return undefined;
  }

  return {
    stanzaId: contextInfo.stanzaId ?? undefined,
    participantJid: contextInfo.participant ?? undefined,
    text: quotedPayload.text,
  };
}

type GroupTextExtractionResult =
  | {
      readonly ok: true;
      readonly groupJid: string;
      readonly messageId: string;
      readonly senderJid: string;
      readonly senderAltJid: string | undefined;
      readonly senderName: string;
      readonly text: string;
      readonly contextInfo: proto.IContextInfo | undefined;
      readonly timestampMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: Exclude<RouterIgnoreReason, 'not_triggered'>;
      readonly groupJid?: string | undefined;
    };

function extractValidWhitelistedGroupMessage(
  msg: WAMessage,
  allowedGroupJids: ReadonlySet<string>,
): GroupTextExtractionResult {
  if (msg.key.fromMe) {
    return { ok: false, reason: 'from_me' };
  }

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || isJidStatusBroadcast(remoteJid)) {
    return { ok: false, reason: 'status_broadcast' };
  }

  if (!isJidGroup(remoteJid)) {
    return { ok: false, reason: 'not_group' };
  }

  if (!allowedGroupJids.has(remoteJid)) {
    return { ok: false, reason: 'group_not_whitelisted', groupJid: remoteJid };
  }

  const { text, contextInfo } = extractTextAndContextInfo(msg.message);
  if (!text) {
    return { ok: false, reason: 'empty_message', groupJid: remoteJid };
  }

  const senderJid = msg.key.participant ?? remoteJid;
  const senderName = msg.pushName?.trim() || jidDecode(senderJid)?.user || 'Unknown Member';

  return {
    ok: true,
    groupJid: remoteJid,
    messageId: msg.key.id ?? `${Date.now()}`,
    senderJid,
    senderAltJid: msg.key.participantAlt ?? undefined,
    senderName,
    text,
    contextInfo,
    timestampMs: toNumber(msg.messageTimestamp) * 1000 || Date.now(),
  };
}

/**
 * Extracts a normalized group message from a whitelisted group for sliding-window memory,
 * regardless of whether Aigis was explicitly mentioned or replied to.
 */
export function observeWhitelistedGroupMessage(
  msg: WAMessage,
  identity: BotIdentity,
  allowedGroupJids: ReadonlySet<string>,
): ObservedGroupMessage | undefined {
  const extracted = extractValidWhitelistedGroupMessage(msg, allowedGroupJids);
  if (!extracted.ok) {
    return undefined;
  }

  const cleanText = stripBotMentionTokens(extracted.text, identity) || extracted.text;
  return {
    groupJid: extracted.groupJid,
    messageId: extracted.messageId,
    senderJid: extracted.senderJid,
    senderAltJid: extracted.senderAltJid,
    senderName: extracted.senderName,
    rawText: extracted.text,
    cleanText,
    timestampMs: extracted.timestampMs,
  };
}

/**
 * Evaluates a single incoming Baileys message and decides whether it should trigger Aigis.
 * Pure function: safe to test without a live WhatsApp socket.
 */
export function routeIncomingMessage(
  msg: WAMessage,
  identity: BotIdentity,
  allowedGroupJids: ReadonlySet<string>,
): RouterDecision {
  const extracted = extractValidWhitelistedGroupMessage(msg, allowedGroupJids);
  if (!extracted.ok) {
    return {
      matched: false,
      reason: extracted.reason,
      ...(extracted.groupJid ? { groupJid: extracted.groupJid } : {}),
    };
  }

  const mentionedJids = extracted.contextInfo?.mentionedJid ?? [];
  const isExplicitMention = mentionedJids.some((jid) => isBotJid(jid, identity));
  const isReplyToBot = isBotJid(extracted.contextInfo?.participant, identity);

  if (!isExplicitMention && !isReplyToBot) {
    return { matched: false, reason: 'not_triggered', groupJid: extracted.groupJid };
  }

  const triggerReason = isExplicitMention ? 'mention' : 'reply_to_bot';

  return {
    matched: true,
    trigger: {
      groupJid: extracted.groupJid,
      messageId: extracted.messageId,
      senderJid: extracted.senderJid,
      senderAltJid: extracted.senderAltJid,
      senderName: extracted.senderName,
      triggerReason,
      cleanPromptText: stripBotMentionTokens(extracted.text, identity),
      rawText: extracted.text,
      quotedContext: extractQuotedContext(extracted.contextInfo),
      timestampMs: extracted.timestampMs,
    },
  };
}
