import type {
  CommunityTriviaContextEntry,
  GroupChatContextEntry,
  MemberContextProfile,
} from '../brain/types.js';
import type { GroupBufferRepository } from './groupBufferRepo.js';
import {
  MemberMemoryRepository,
  resolvePhoneDigitsFromJids,
} from './memberMemoryRepo.js';

export interface ObserveMessageParams {
  readonly groupJid: string;
  readonly messageId: string;
  readonly senderJid: string;
  readonly senderAltJid?: string | undefined;
  readonly senderName: string;
  readonly text: string;
  readonly timestampMs: number;
}

export interface BuildMemoryContextParams {
  readonly groupJid: string;
  readonly currentMessageId?: string | undefined;
  readonly senderJid: string;
  readonly senderAltJid?: string | undefined;
  readonly senderName: string;
  readonly promptText: string;
  readonly quotedText?: string | undefined;
  readonly quotedStanzaId?: string | undefined;
  readonly quotedParticipantJid?: string | undefined;
  readonly quotedParticipantAltJid?: string | undefined;
  readonly timestampMs?: number | undefined;
}

export interface PromptMemoryContext {
  readonly recentMessages: readonly GroupChatContextEntry[];
  readonly memberProfile: MemberContextProfile;
  readonly matchedTrivia: readonly CommunityTriviaContextEntry[];
  readonly quotedParticipantLabel: string | undefined;
}

export interface RecordBotReplyParams {
  readonly groupJid: string;
  readonly messageId: string;
  readonly botJid: string;
  readonly text: string;
  readonly timestampMs?: number | undefined;
}

/**
 * Coordinates sliding-window group chat persistence, member Social Link profiles,
 * and safe founder/admin trivia assembly for AigisBrain requests.
 */
export class MemoryContextService {
  constructor(
    private readonly groupBuffer: GroupBufferRepository,
    private readonly memberMemory: MemberMemoryRepository,
    private readonly windowSize: number,
    private readonly retentionLimit: number,
  ) {}

  /**
   * Passively records an incoming whitelisted group message into the sliding window
   * and updates the sender's last-seen metadata without incrementing bot interaction rank.
   */
  recordObservedMessage(params: ObserveMessageParams): void {
    const senderPhone = resolvePhoneDigitsFromJids(params.senderJid, params.senderAltJid);
    this.groupBuffer.saveMessage(
      {
        groupJid: params.groupJid,
        messageId: params.messageId,
        senderJid: params.senderJid,
        senderAltJid: params.senderAltJid,
        senderPhone,
        senderName: params.senderName,
        text: params.text,
        isFromBot: false,
        timestampMs: params.timestampMs,
      },
      this.retentionLimit,
    );

    this.memberMemory.touchMember({
      groupJid: params.groupJid,
      senderJid: params.senderJid,
      senderAltJid: params.senderAltJid,
      senderName: params.senderName,
      timestampMs: params.timestampMs,
      incrementInteraction: false,
    });
  }

  /**
   * Increments interaction bond for the triggering member and assembles safe context
   * (recent window, member profile, quoted author label, and matched trivia without phone numbers).
   */
  preparePromptContext(params: BuildMemoryContextParams): PromptMemoryContext {
    const member = this.memberMemory.touchMember({
      groupJid: params.groupJid,
      senderJid: params.senderJid,
      senderAltJid: params.senderAltJid,
      senderName: params.senderName,
      timestampMs: params.timestampMs,
      incrementInteraction: true,
    });

    const senderTrivia = this.memberMemory.findTriviaByJids([
      params.senderJid,
      params.senderAltJid,
    ]);

    const recentMessages: GroupChatContextEntry[] = this.groupBuffer
      .getRecentMessages(params.groupJid, this.windowSize, params.currentMessageId)
      .map((row) => ({
        senderName: row.senderName,
        text: row.text,
        isFromBot: row.isFromBot,
        timestampMs: row.timestampMs,
      }));

    const queryText = `${params.promptText} ${params.quotedText ?? ''}`.trim();
    const matchedTrivia: CommunityTriviaContextEntry[] = this.memberMemory
      .findMatchingTrivia(queryText, [
        params.senderJid,
        params.senderAltJid,
        params.quotedParticipantJid,
        params.quotedParticipantAltJid,
      ])
      .map((entry) => ({
        displayName: entry.displayName,
        role: entry.role,
        trivia: entry.trivia,
      }));

    const quotedParticipantLabel = this.resolveQuotedParticipantLabel(params);

    return {
      recentMessages,
      memberProfile: {
        displayName: member.displayName,
        communityRole: senderTrivia?.role,
        bondLevel: member.bondLevel,
        interactionCount: member.interactionCount,
        favoriteGames: member.favoriteGames,
        notes: member.notes,
      },
      matchedTrivia,
      quotedParticipantLabel,
    };
  }

  /**
   * Persists Aigis's sent reply into the group buffer so future turns remember what Aigis said.
   */
  recordBotReply(params: RecordBotReplyParams): void {
    this.groupBuffer.saveMessage(
      {
        groupJid: params.groupJid,
        messageId: params.messageId,
        senderJid: params.botJid,
        senderName: 'Aigis',
        text: params.text,
        isFromBot: true,
        timestampMs: params.timestampMs ?? Date.now(),
      },
      this.retentionLimit,
    );
  }

  private resolveQuotedParticipantLabel(params: BuildMemoryContextParams): string | undefined {
    if (params.quotedStanzaId) {
      const bufferedMsg = this.groupBuffer.findMessageById(params.groupJid, params.quotedStanzaId);
      if (bufferedMsg) {
        return bufferedMsg.isFromBot ? 'Aigis' : bufferedMsg.senderName;
      }
    }

    if (params.quotedParticipantJid) {
      const remembered = this.memberMemory.getMemberByIdentity(
        params.groupJid,
        params.quotedParticipantJid,
        params.quotedParticipantAltJid,
      );
      if (remembered) {
        return remembered.displayName;
      }

      const triviaOwner = this.memberMemory.findTriviaByJids([
        params.quotedParticipantJid,
        params.quotedParticipantAltJid,
      ]);
      if (triviaOwner) {
        return triviaOwner.displayName;
      }

      return 'Another Group Member';
    }

    return undefined;
  }
}
