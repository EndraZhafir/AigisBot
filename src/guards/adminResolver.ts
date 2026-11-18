import { jidDecode, jidNormalizedUser, type GroupMetadata } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import { extractPhoneDigitsFromJid } from '../memory/memberMemoryRepo.js';
import type { AdminResolutionResult, GroupAdminSnapshot } from './types.js';

export interface GroupMetadataFetcher {
  groupMetadata(jid: string): Promise<GroupMetadata>;
}

function collectCandidateIdentifiers(
  jid: string | undefined,
  adminJids: Set<string>,
  adminUsers: Set<string>,
): void {
  if (!jid) {
    return;
  }

  const normalized = jidNormalizedUser(jid);
  if (!normalized) {
    return;
  }

  adminJids.add(normalized);
  const decodedUser = jidDecode(normalized)?.user;
  if (decodedUser) {
    adminUsers.add(decodedUser);
  }
}

/**
 * Extracts normalized JIDs and decoded user parts for all current admins/superadmins
 * from WhatsApp GroupMetadata.
 */
export function buildGroupAdminSnapshot(
  metadata: GroupMetadata,
  fetchedAtMs: number = Date.now(),
): GroupAdminSnapshot {
  const adminJids = new Set<string>();
  const adminUsers = new Set<string>();

  for (const participant of metadata.participants) {
    const isAdmin =
      participant.admin === 'admin' ||
      participant.admin === 'superadmin' ||
      participant.isAdmin === true ||
      participant.isSuperAdmin === true;

    if (!isAdmin) {
      continue;
    }

    collectCandidateIdentifiers(participant.id, adminJids, adminUsers);
    collectCandidateIdentifiers(participant.lid, adminJids, adminUsers);
    collectCandidateIdentifiers(participant.phoneNumber, adminJids, adminUsers);
  }

  return {
    groupJid: metadata.id,
    adminJids,
    adminUsers,
    fetchedAtMs,
  };
}

function isJidInAdminSnapshot(
  jid: string | undefined,
  snapshot: GroupAdminSnapshot | undefined,
): boolean {
  if (!jid || !snapshot) {
    return false;
  }

  const normalized = jidNormalizedUser(jid);
  if (snapshot.adminJids.has(normalized)) {
    return true;
  }

  const decodedUser = jidDecode(normalized)?.user;
  return Boolean(decodedUser && snapshot.adminUsers.has(decodedUser));
}

/**
 * Pure helper that determines whether a sender qualifies for Admin ("Pro Tier")
 * based on a WhatsApp group admin snapshot and optional BOT_OWNER_NUMBERS fallback.
 */
export function resolveSenderTierFromSnapshot(params: {
  readonly snapshot: GroupAdminSnapshot | undefined;
  readonly senderJid: string;
  readonly senderAltJid?: string | undefined;
  readonly botOwnerNumbers: ReadonlySet<string>;
}): AdminResolutionResult {
  const isGroupAdmin =
    isJidInAdminSnapshot(params.senderJid, params.snapshot) ||
    isJidInAdminSnapshot(params.senderAltJid, params.snapshot);

  const senderPhone =
    extractPhoneDigitsFromJid(params.senderJid) ??
    extractPhoneDigitsFromJid(params.senderAltJid);
  const isBotOwner = Boolean(senderPhone && params.botOwnerNumbers.has(senderPhone));

  if (isGroupAdmin) {
    return {
      tier: 'admin',
      isGroupAdmin: true,
      isBotOwner,
      resolvedBy: 'group_metadata',
    };
  }

  if (isBotOwner) {
    return {
      tier: 'admin',
      isGroupAdmin: false,
      isBotOwner: true,
      resolvedBy: 'bot_owner',
    };
  }

  return {
    tier: 'member',
    isGroupAdmin: false,
    isBotOwner: false,
    resolvedBy: 'member_default',
  };
}

/**
 * Resolves WhatsApp Group Admin status using cached `groupMetadata` snapshots
 * with concurrent-fetch deduplication and event-based invalidation.
 */
export class GroupAdminResolver {
  private readonly cache = new Map<string, GroupAdminSnapshot>();
  private readonly inflightFetches = new Map<string, Promise<GroupAdminSnapshot | undefined>>();

  constructor(
    private readonly cacheTtlMs: number,
    private readonly botOwnerNumbers: ReadonlySet<string>,
    private readonly logger?: Logger,
    private readonly nowProvider: () => number = () => Date.now(),
  ) {}

  invalidateGroup(groupJid: string): void {
    this.cache.delete(groupJid);
  }

  async resolveSenderTier(
    fetcher: GroupMetadataFetcher | undefined,
    groupJid: string,
    senderJid: string,
    senderAltJid?: string,
  ): Promise<AdminResolutionResult> {
    const snapshot = fetcher ? await this.getOrFetchSnapshot(fetcher, groupJid) : undefined;
    return resolveSenderTierFromSnapshot({
      snapshot,
      senderJid,
      senderAltJid,
      botOwnerNumbers: this.botOwnerNumbers,
    });
  }

  private async getOrFetchSnapshot(
    fetcher: GroupMetadataFetcher,
    groupJid: string,
  ): Promise<GroupAdminSnapshot | undefined> {
    const nowMs = this.nowProvider();
    const cached = this.cache.get(groupJid);
    if (cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return cached;
    }

    const existingFetch = this.inflightFetches.get(groupJid);
    if (existingFetch) {
      return existingFetch;
    }

    const fetchPromise = fetcher
      .groupMetadata(groupJid)
      .then((metadata) => {
        const snapshot = buildGroupAdminSnapshot(metadata, this.nowProvider());
        this.cache.set(groupJid, snapshot);
        return snapshot;
      })
      .catch((err: unknown) => {
        this.logger?.warn(
          { err, groupJid },
          'Failed to fetch WhatsApp group metadata; falling back to stale cache or member tier.',
        );
        return cached;
      })
      .finally(() => {
        this.inflightFetches.delete(groupJid);
      });

    this.inflightFetches.set(groupJid, fetchPromise);
    return fetchPromise;
  }
}
