export type SenderTier = 'admin' | 'member';

export type AdminResolutionSource = 'group_metadata' | 'bot_owner' | 'member_default';

export interface AdminResolutionResult {
  readonly tier: SenderTier;
  readonly isGroupAdmin: boolean;
  readonly isBotOwner: boolean;
  readonly resolvedBy: AdminResolutionSource;
}

export interface GroupAdminSnapshot {
  readonly groupJid: string;
  readonly adminJids: ReadonlySet<string>;
  readonly adminUsers: ReadonlySet<string>;
  readonly fetchedAtMs: number;
}

export type RateLimitRejectReason = 'in_flight' | 'user_cooldown' | 'group_cooldown';

export interface RateLimitCheckInput {
  readonly groupJid: string;
  readonly actorKey: string;
  readonly tier: SenderTier;
  readonly nowMs?: number | undefined;
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly tier: SenderTier;
      readonly actorKey: string;
      readonly releaseLock: () => void;
    }
  | {
      readonly allowed: false;
      readonly tier: SenderTier;
      readonly actorKey: string;
      readonly reason: RateLimitRejectReason;
      readonly retryAfterMs: number;
      readonly shouldReact: boolean;
    };

export interface RateLimiterOptions {
  readonly userCooldownMs: number;
  readonly adminCooldownMs: number;
  readonly groupCooldownMs: number;
  readonly adminGroupCooldownMs: number;
  readonly reactionCooldownMs?: number | undefined;
  readonly maxTrackedUsers?: number | undefined;
}

export interface SanitizeTextOptions {
  readonly maxChars: number;
  readonly neutralizeInjection?: boolean | undefined;
}

export interface SanitizeResult {
  readonly text: string;
  readonly wasTruncated: boolean;
  readonly hadInjectionSignals: boolean;
  readonly removedZeroWidthCount: number;
}
