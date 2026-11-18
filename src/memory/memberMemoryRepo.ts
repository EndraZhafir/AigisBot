import type { DatabaseSync } from 'node:sqlite';
import { jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';
import { normalizePhoneDigits } from '../config/env.js';
import type {
  CommunityTriviaRecord,
  MemberMemoryRecord,
  TouchMemberMemoryInput,
} from './types.js';

interface MemberMemoryRow {
  id: number;
  group_jid: string;
  member_key: string;
  primary_jid: string;
  alt_jid: string | null;
  phone_digits: string | null;
  display_name: string;
  preferred_language: string | null;
  favorite_games: string | null;
  notes: string | null;
  interaction_count: number;
  bond_level: number;
  first_seen_ms: number;
  last_seen_ms: number;
}

interface CommunityTriviaRow {
  id: number;
  slug: string;
  display_name: string;
  role: string;
  phone_digits: string | null;
  aliases_json: string;
  trivia: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const BROAD_COMMUNITY_TRIVIA_PATTERN =
  /\b(founders?|co-?founders?|pendiri|admins?|pengurus|moderators?|staff|kreator|creators?|pembuat\s*bot|developers?|owners?)\b/i;

function mapMemberMemoryRow(row: MemberMemoryRow): MemberMemoryRecord {
  const preferredLanguage =
    row.preferred_language === 'en' || row.preferred_language === 'id'
      ? row.preferred_language
      : undefined;

  return {
    id: row.id,
    groupJid: row.group_jid,
    memberKey: row.member_key,
    primaryJid: row.primary_jid,
    altJid: row.alt_jid ?? undefined,
    phoneDigits: row.phone_digits ?? undefined,
    displayName: row.display_name,
    preferredLanguage,
    favoriteGames: row.favorite_games ?? undefined,
    notes: row.notes ?? undefined,
    interactionCount: row.interaction_count,
    bondLevel: row.bond_level,
    firstSeenMs: row.first_seen_ms,
    lastSeenMs: row.last_seen_ms,
  };
}

function parseAliasesJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mapCommunityTriviaRow(row: CommunityTriviaRow): CommunityTriviaRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    role: row.role,
    phoneDigits: row.phone_digits ?? undefined,
    aliases: parseAliasesJson(row.aliases_json),
    trivia: row.trivia,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textContainsAlias(normalizedText: string, alias: string): boolean {
  if (!alias) {
    return false;
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(alias)}([^a-z0-9]|$)`, 'i').test(normalizedText);
}

/**
 * Extracts normalized phone digits when the given JID is a phone-based JID
 * (`@s.whatsapp.net`, `@c.us`, or `@hosted`), ignoring `@lid` and `@g.us`.
 */
export function extractPhoneDigitsFromJid(jid: string | undefined): string | undefined {
  if (!jid) {
    return undefined;
  }

  const normalized = jidNormalizedUser(jid);
  const decoded = jidDecode(normalized);
  if (!decoded?.user || decoded.server === 'lid' || decoded.server === 'g.us') {
    return undefined;
  }

  return normalizePhoneDigits(decoded.user);
}

/**
 * Resolves normalized phone digits from either primary or alternate JID.
 */
export function resolvePhoneDigitsFromJids(
  primaryJid: string,
  altJid?: string,
): string | undefined {
  return extractPhoneDigitsFromJid(primaryJid) ?? extractPhoneDigitsFromJid(altJid);
}

/**
 * Produces a stable canonical member key per user across `@lid` and `@s.whatsapp.net`.
 */
export function buildCanonicalMemberKey(primaryJid: string, phoneDigits?: string): string {
  if (phoneDigits) {
    return `pn:${phoneDigits}`;
  }

  const normalized = jidNormalizedUser(primaryJid);
  const decoded = jidDecode(normalized);
  if (decoded?.server === 'lid' && decoded.user) {
    return `lid:${decoded.user}`;
  }
  return `jid:${normalized}`;
}

/**
 * Computes Persona-style Social Link / Bond Rank (1 to 10) from interaction count.
 */
export function calculateBondLevel(interactionCount: number): number {
  const safeCount = Math.max(0, Math.floor(interactionCount));
  return Math.min(10, 1 + Math.floor(Math.sqrt(safeCount)));
}

/**
 * Manages per-member Social Link memories and ATLUS Jogja founder/admin trivia lookups.
 */
export class MemberMemoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Creates or updates a member memory row, unifying `@lid` and phone JIDs when phone digits are resolved.
   */
  touchMember(input: TouchMemberMemoryInput): MemberMemoryRecord {
    const nowMs = input.timestampMs ?? Date.now();
    const normalizedPrimary = jidNormalizedUser(input.senderJid);
    const normalizedAlt = input.senderAltJid ? jidNormalizedUser(input.senderAltJid) : undefined;
    const phoneDigits = resolvePhoneDigitsFromJids(normalizedPrimary, normalizedAlt);
    const canonicalKey = buildCanonicalMemberKey(normalizedPrimary, phoneDigits);
    const cleanName = input.senderName.trim() || 'Unknown Member';
    const delta = input.incrementInteraction ? 1 : 0;

    const existing = this.findExistingMemberRow(
      input.groupJid,
      canonicalKey,
      normalizedPrimary,
      normalizedAlt,
      phoneDigits,
    );

    if (!existing) {
      const interactionCount = delta;
      const bondLevel = calculateBondLevel(interactionCount);

      this.db
        .prepare(
          `
          INSERT INTO member_memories (
            group_jid,
            member_key,
            primary_jid,
            alt_jid,
            phone_digits,
            display_name,
            preferred_language,
            favorite_games,
            notes,
            interaction_count,
            bond_level,
            first_seen_ms,
            last_seen_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
          `,
        )
        .run(
          input.groupJid,
          canonicalKey,
          normalizedPrimary,
          normalizedAlt ?? null,
          phoneDigits ?? null,
          cleanName,
          input.preferredLanguage ?? null,
          interactionCount,
          bondLevel,
          nowMs,
          nowMs,
        );

      return this.getMemberByKey(input.groupJid, canonicalKey)!;
    }

    const mergedPhone = phoneDigits ?? existing.phone_digits ?? undefined;
    const upgradedKey = mergedPhone ? `pn:${mergedPhone}` : existing.member_key;
    const nextInteractionCount = existing.interaction_count + delta;
    const nextBondLevel = calculateBondLevel(nextInteractionCount);
    const nextLanguage = input.preferredLanguage ?? existing.preferred_language ?? null;

    // Avoid UNIQUE conflict if another row already claimed the upgraded `pn:` key.
    const conflictRow =
      upgradedKey !== existing.member_key
        ? this.db
            .prepare(
              'SELECT id FROM member_memories WHERE group_jid = ? AND member_key = ? AND id <> ? LIMIT 1',
            )
            .get(input.groupJid, upgradedKey, existing.id)
        : undefined;
    const finalKey = conflictRow ? existing.member_key : upgradedKey;

    this.db
      .prepare(
        `
        UPDATE member_memories
        SET
          member_key = ?,
          primary_jid = ?,
          alt_jid = COALESCE(?, alt_jid),
          phone_digits = COALESCE(?, phone_digits),
          display_name = ?,
          preferred_language = ?,
          interaction_count = ?,
          bond_level = ?,
          last_seen_ms = ?
        WHERE id = ?
        `,
      )
      .run(
        finalKey,
        normalizedPrimary,
        normalizedAlt ?? null,
        mergedPhone ?? null,
        cleanName,
        nextLanguage,
        nextInteractionCount,
        nextBondLevel,
        Math.max(existing.last_seen_ms, nowMs),
        existing.id,
      );

    return this.getMemberByKey(input.groupJid, finalKey)!;
  }

  /**
   * Looks up a member record by any known JID (`@lid` or phone JID).
   */
  getMemberByIdentity(
    groupJid: string,
    senderJid: string,
    senderAltJid?: string,
  ): MemberMemoryRecord | undefined {
    const normalizedPrimary = jidNormalizedUser(senderJid);
    const normalizedAlt = senderAltJid ? jidNormalizedUser(senderAltJid) : undefined;
    const phoneDigits = resolvePhoneDigitsFromJids(normalizedPrimary, normalizedAlt);
    const canonicalKey = buildCanonicalMemberKey(normalizedPrimary, phoneDigits);

    const row = this.findExistingMemberRow(
      groupJid,
      canonicalKey,
      normalizedPrimary,
      normalizedAlt,
      phoneDigits,
    );
    return row ? mapMemberMemoryRow(row) : undefined;
  }

  /**
   * Updates optional profile notes or favorite ATLUS games for a member.
   */
  updateMemberPreferences(
    groupJid: string,
    memberKey: string,
    patch: {
      favoriteGames?: string | undefined;
      notes?: string | undefined;
      preferredLanguage?: 'en' | 'id' | undefined;
    },
  ): MemberMemoryRecord | undefined {
    const existing = this.getMemberByKey(groupJid, memberKey);
    if (!existing) {
      return undefined;
    }

    this.db
      .prepare(
        `
        UPDATE member_memories
        SET
          favorite_games = ?,
          notes = ?,
          preferred_language = ?
        WHERE id = ?
        `,
      )
      .run(
        patch.favoriteGames !== undefined ? patch.favoriteGames.trim() || null : existing.favoriteGames ?? null,
        patch.notes !== undefined ? patch.notes.trim() || null : existing.notes ?? null,
        patch.preferredLanguage ?? existing.preferredLanguage ?? null,
        existing.id,
      );

    return this.getMemberByKey(groupJid, memberKey);
  }

  /**
   * Finds a community founder/admin dossier entry matching any of the given JIDs by phone digits.
   */
  findTriviaByJids(jids: readonly (string | undefined)[]): CommunityTriviaRecord | undefined {
    for (const jid of jids) {
      const digits = extractPhoneDigitsFromJid(jid);
      if (!digits) {
        continue;
      }
      const row = this.db
        .prepare('SELECT * FROM community_trivia WHERE phone_digits = ? LIMIT 1')
        .get(digits) as CommunityTriviaRow | undefined;
      if (row) {
        return mapCommunityTriviaRow(row);
      }
    }
    return undefined;
  }

  /**
   * Returns all community founder/admin trivia rows sorted by insertion order.
   */
  listAllTrivia(): CommunityTriviaRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM community_trivia ORDER BY id ASC')
      .all() as unknown as CommunityTriviaRow[];

    return rows.map(mapCommunityTriviaRow);
  }

  /**
   * Finds relevant founder/admin trivia rows based on aliases mentioned in text
   * or phone digits belonging to the active/quoted participants.
   */
  findMatchingTrivia(
    queryText: string,
    participantJids: readonly (string | undefined)[] = [],
    limit: number = 6,
  ): CommunityTriviaRecord[] {
    const allRows = this.listAllTrivia();
    if (allRows.length === 0 || limit <= 0) {
      return [];
    }

    const normalizedText = queryText.trim().toLowerCase();
    const participantPhones = new Set<string>();
    for (const jid of participantJids) {
      const digits = extractPhoneDigitsFromJid(jid);
      if (digits) {
        participantPhones.add(digits);
      }
    }

    const matched: CommunityTriviaRecord[] = [];
    const seenSlugs = new Set<string>();
    const pushIfNew = (entry: CommunityTriviaRecord): void => {
      if (!seenSlugs.has(entry.slug) && matched.length < limit) {
        seenSlugs.add(entry.slug);
        matched.push(entry);
      }
    };

    // Priority 1: Explicitly mentioned person/alias or role inquiry.
    const isBroadInquiry = BROAD_COMMUNITY_TRIVIA_PATTERN.test(normalizedText);
    for (const row of allRows) {
      const matchesAlias =
        textContainsAlias(normalizedText, row.displayName.toLowerCase()) ||
        row.aliases.some((alias) => textContainsAlias(normalizedText, alias));
      if (matchesAlias) {
        pushIfNew(row);
      }
    }

    if (isBroadInquiry) {
      for (const row of allRows) {
        pushIfNew(row);
      }
    }

    // Priority 2: Participant identity matches a founder/admin phone number.
    for (const row of allRows) {
      if (row.phoneDigits && participantPhones.has(row.phoneDigits)) {
        pushIfNew(row);
      }
    }

    return matched;
  }

  private getMemberByKey(groupJid: string, memberKey: string): MemberMemoryRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM member_memories WHERE group_jid = ? AND member_key = ? LIMIT 1')
      .get(groupJid, memberKey) as MemberMemoryRow | undefined;

    return row ? mapMemberMemoryRow(row) : undefined;
  }

  private findExistingMemberRow(
    groupJid: string,
    canonicalKey: string,
    primaryJid: string,
    altJid: string | undefined,
    phoneDigits: string | undefined,
  ): MemberMemoryRow | undefined {
    const candidateJids = [primaryJid, altJid].filter((j): j is string => Boolean(j));

    const byKey = this.db
      .prepare('SELECT * FROM member_memories WHERE group_jid = ? AND member_key = ? LIMIT 1')
      .get(groupJid, canonicalKey) as MemberMemoryRow | undefined;
    if (byKey) {
      return byKey;
    }

    if (phoneDigits) {
      const byPhone = this.db
        .prepare('SELECT * FROM member_memories WHERE group_jid = ? AND phone_digits = ? LIMIT 1')
        .get(groupJid, phoneDigits) as MemberMemoryRow | undefined;
      if (byPhone) {
        return byPhone;
      }
    }

    for (const candidateJid of candidateJids) {
      const byJid = this.db
        .prepare(
          'SELECT * FROM member_memories WHERE group_jid = ? AND (primary_jid = ? OR alt_jid = ?) LIMIT 1',
        )
        .get(groupJid, candidateJid, candidateJid) as MemberMemoryRow | undefined;
      if (byJid) {
        return byJid;
      }
    }

    return undefined;
  }
}
