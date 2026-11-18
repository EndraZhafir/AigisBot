export interface GroupMessageRecord {
  readonly id: number;
  readonly groupJid: string;
  readonly messageId: string;
  readonly senderJid: string;
  readonly senderAltJid: string | undefined;
  readonly senderPhone: string | undefined;
  readonly senderName: string;
  readonly text: string;
  readonly isFromBot: boolean;
  readonly timestampMs: number;
  readonly createdAtMs: number;
}

export interface SaveGroupMessageInput {
  readonly groupJid: string;
  readonly messageId: string;
  readonly senderJid: string;
  readonly senderAltJid?: string | undefined;
  readonly senderPhone?: string | undefined;
  readonly senderName: string;
  readonly text: string;
  readonly isFromBot?: boolean | undefined;
  readonly timestampMs: number;
}

export interface MemberMemoryRecord {
  readonly id: number;
  readonly groupJid: string;
  readonly memberKey: string;
  readonly primaryJid: string;
  readonly altJid: string | undefined;
  readonly phoneDigits: string | undefined;
  readonly displayName: string;
  readonly preferredLanguage: 'en' | 'id' | undefined;
  readonly favoriteGames: string | undefined;
  readonly notes: string | undefined;
  readonly interactionCount: number;
  readonly bondLevel: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

export interface TouchMemberMemoryInput {
  readonly groupJid: string;
  readonly senderJid: string;
  readonly senderAltJid?: string | undefined;
  readonly senderName: string;
  readonly preferredLanguage?: 'en' | 'id' | undefined;
  readonly timestampMs?: number | undefined;
  readonly incrementInteraction?: boolean | undefined;
}

export interface CommunityTriviaRecord {
  readonly id: number;
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly phoneDigits: string | undefined;
  readonly aliases: readonly string[];
  readonly trivia: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CommunitySeedEntry {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly phoneDigits?: string | undefined;
  readonly aliases: readonly string[];
  readonly trivia: string;
}

export type GroupModerationMode = 'off' | 'alert' | 'enforce';

export interface GroupSettingsRecord {
  readonly groupJid: string;
  readonly moderationMode: GroupModerationMode;
  readonly updatedAtMs: number;
}

export interface MemoryContextSnapshot {
  readonly recentMessages: readonly GroupMessageRecord[];
  readonly activeMember: MemberMemoryRecord | undefined;
  readonly matchedTrivia: readonly CommunityTriviaRecord[];
}
