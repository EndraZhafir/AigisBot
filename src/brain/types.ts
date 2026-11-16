export type BrainMode = 'casual' | 'serious';

export type TargetReplyLanguage = 'en' | 'id';

export interface BrainRequest {
  readonly senderName: string;
  readonly senderJid: string;
  readonly promptText: string;
  readonly quotedText?: string | undefined;
  readonly quotedParticipantLabel?: string | undefined;
  readonly now?: Date | undefined;
}

export interface GroundedArticle {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly publishedTimestampMs: number;
  readonly source: string;
  readonly videoUrl?: string | undefined;
}

export interface BrainStructuredPayload {
  readonly detectedInputLanguage: string;
  readonly needsTranslationDisplay: boolean;
  readonly translationText: string;
  readonly replyLanguage: TargetReplyLanguage;
  readonly reply: string;
}

export interface BrainResponse {
  readonly mode: BrainMode;
  readonly formattedText: string;
  readonly provider: 'gemini' | 'groq' | 'fallback';
  readonly modelUsed?: string | undefined;
  readonly groundingUrls: readonly string[];
}
