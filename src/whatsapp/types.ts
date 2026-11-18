/**
 * Normalized WhatsApp identities for the running bot account.
 * Modern WhatsApp groups may address participants by either Phone JID (@s.whatsapp.net)
 * or Linked ID (@lid), so both must be tracked for mention and reply detection.
 */
export interface BotIdentity {
  readonly phoneJid: string | undefined;
  readonly lidJid: string | undefined;
}

export type TriggerReason = 'mention' | 'reply_to_bot';

export interface QuotedMessageContext {
  readonly stanzaId: string | undefined;
  readonly participantJid: string | undefined;
  readonly text: string;
}

export interface ObservedGroupMessage {
  readonly groupJid: string;
  readonly messageId: string;
  readonly senderJid: string;
  readonly senderAltJid: string | undefined;
  readonly senderName: string;
  readonly rawText: string;
  readonly cleanText: string;
  readonly timestampMs: number;
}

export interface IncomingGroupTrigger {
  readonly groupJid: string;
  readonly messageId: string;
  readonly senderJid: string;
  readonly senderAltJid: string | undefined;
  readonly senderName: string;
  readonly triggerReason: TriggerReason;
  readonly cleanPromptText: string;
  readonly rawText: string;
  readonly quotedContext: QuotedMessageContext | undefined;
  readonly timestampMs: number;
}

export type RouterIgnoreReason =
  | 'from_me'
  | 'status_broadcast'
  | 'not_group'
  | 'group_not_whitelisted'
  | 'empty_message'
  | 'not_triggered';

export type RouterDecision =
  | {
      readonly matched: true;
      readonly trigger: IncomingGroupTrigger;
    }
  | {
      readonly matched: false;
      readonly reason: RouterIgnoreReason;
      readonly groupJid?: string | undefined;
    };
