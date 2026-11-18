import {
  buildCanonicalMemberKey,
  resolvePhoneDigitsFromJids,
} from '../memory/memberMemoryRepo.js';
import type {
  RateLimitCheckInput,
  RateLimitDecision,
  RateLimiterOptions,
} from './types.js';

const DEFAULT_MAX_TRACKED_USERS = 500;

/**
 * Derives a stable rate-limit actor key from phone digits (when known) or `@lid`/JID.
 */
export function buildRateLimitActorKey(senderJid: string, senderAltJid?: string): string {
  const phoneDigits = resolvePhoneDigitsFromJids(senderJid, senderAltJid);
  return buildCanonicalMemberKey(senderJid, phoneDigits);
}

/**
 * Enforces multi-layer anti-flood protection:
 * 1. Per-group in-flight mutex lock (prevents concurrent reply bursts)
 * 2. Tiered per-user cooldown (Admin Pro-Tier vs Member Free-Tier)
 * 3. Tiered per-group global cooldown
 * 4. Throttled cooldown emoji reaction tracking so even ⏳ reactions never spam
 */
export class TieredRateLimiter {
  private readonly inFlightGroups = new Set<string>();
  private readonly lastUserReplyMs = new Map<string, number>();
  private readonly lastGroupReplyMs = new Map<string, number>();
  private readonly lastReactionMs = new Map<string, number>();
  private readonly reactionCooldownMs: number;
  private readonly maxTrackedUsers: number;

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly nowProvider: () => number = () => Date.now(),
  ) {
    this.reactionCooldownMs =
      options.reactionCooldownMs ?? Math.max(5_000, options.groupCooldownMs);
    this.maxTrackedUsers = options.maxTrackedUsers ?? DEFAULT_MAX_TRACKED_USERS;
  }

  tryAcquire(input: RateLimitCheckInput): RateLimitDecision {
    const nowMs = input.nowMs ?? this.nowProvider();
    const userWindowMs =
      input.tier === 'admin' ? this.options.adminCooldownMs : this.options.userCooldownMs;
    const groupWindowMs =
      input.tier === 'admin' ? this.options.adminGroupCooldownMs : this.options.groupCooldownMs;

    if (this.inFlightGroups.has(input.groupJid)) {
      return {
        allowed: false,
        tier: input.tier,
        actorKey: input.actorKey,
        reason: 'in_flight',
        retryAfterMs: groupWindowMs,
        shouldReact: this.consumeReactionAllowance(input.groupJid, input.actorKey, nowMs),
      };
    }

    const lastUserAt = this.lastUserReplyMs.get(input.actorKey);
    if (lastUserAt !== undefined) {
      const elapsedUserMs = nowMs - lastUserAt;
      if (elapsedUserMs < userWindowMs) {
        return {
          allowed: false,
          tier: input.tier,
          actorKey: input.actorKey,
          reason: 'user_cooldown',
          retryAfterMs: userWindowMs - elapsedUserMs,
          shouldReact: this.consumeReactionAllowance(input.groupJid, input.actorKey, nowMs),
        };
      }
    }

    const lastGroupAt = this.lastGroupReplyMs.get(input.groupJid);
    if (lastGroupAt !== undefined) {
      const elapsedGroupMs = nowMs - lastGroupAt;
      if (elapsedGroupMs < groupWindowMs) {
        return {
          allowed: false,
          tier: input.tier,
          actorKey: input.actorKey,
          reason: 'group_cooldown',
          retryAfterMs: groupWindowMs - elapsedGroupMs,
          shouldReact: this.consumeReactionAllowance(input.groupJid, input.actorKey, nowMs),
        };
      }
    }

    this.inFlightGroups.add(input.groupJid);
    let released = false;

    const releaseLock = (): void => {
      if (released) {
        return;
      }
      released = true;
      this.inFlightGroups.delete(input.groupJid);

      const finishedAtMs = this.nowProvider();
      this.recordTimestamp(this.lastUserReplyMs, input.actorKey, finishedAtMs);
      this.lastGroupReplyMs.set(input.groupJid, finishedAtMs);
    };

    return {
      allowed: true,
      tier: input.tier,
      actorKey: input.actorKey,
      releaseLock,
    };
  }

  private consumeReactionAllowance(groupJid: string, actorKey: string, nowMs: number): boolean {
    const key = `${groupJid}::${actorKey}`;
    const lastReactedAt = this.lastReactionMs.get(key);
    if (lastReactedAt !== undefined && nowMs - lastReactedAt < this.reactionCooldownMs) {
      return false;
    }

    this.recordTimestamp(this.lastReactionMs, key, nowMs);
    return true;
  }

  private recordTimestamp(map: Map<string, number>, key: string, timestampMs: number): void {
    // Re-insert so insertion order tracks most-recently-active keys for bounded eviction.
    map.delete(key);
    map.set(key, timestampMs);

    while (map.size > this.maxTrackedUsers) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      map.delete(oldestKey);
    }
  }
}
