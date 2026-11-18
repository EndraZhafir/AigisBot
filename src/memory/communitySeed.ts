import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from 'pino';
import { normalizePhoneDigits } from '../config/env.js';
import type { CommunitySeedEntry } from './types.js';

interface RawCommunitySeedEntry {
  slug?: unknown;
  displayName?: unknown;
  role?: unknown;
  phone?: unknown;
  phoneDigits?: unknown;
  aliases?: unknown;
  trivia?: unknown;
}

function normalizeSlug(rawSlug: unknown, fallbackName: string): string {
  const base = typeof rawSlug === 'string' && rawSlug.trim() ? rawSlug.trim() : fallbackName;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeAliases(rawAliases: unknown, displayName: string): string[] {
  const set = new Set<string>();
  const normalizedDisplay = displayName.trim().toLowerCase();
  if (normalizedDisplay) {
    set.add(normalizedDisplay);
  }

  if (Array.isArray(rawAliases)) {
    for (const item of rawAliases) {
      if (typeof item !== 'string') {
        continue;
      }
      const trimmed = item.trim().toLowerCase();
      if (trimmed) {
        set.add(trimmed);
      }
    }
  }

  return [...set];
}

/**
 * Parses and validates a JSON community seed array, normalizing phone numbers and aliases.
 */
export function parseCommunitySeedJson(rawJson: string): CommunitySeedEntry[] {
  const parsed: unknown = JSON.parse(rawJson);
  if (!Array.isArray(parsed)) {
    throw new Error('Community seed JSON must be an array of entries.');
  }

  const entries: CommunitySeedEntry[] = [];
  const seenSlugs = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const raw = item as RawCommunitySeedEntry;
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const role = typeof raw.role === 'string' ? raw.role.trim() : '';
    if (!displayName || !role) {
      continue;
    }

    const slug = normalizeSlug(raw.slug, displayName);
    if (!slug || seenSlugs.has(slug)) {
      continue;
    }
    seenSlugs.add(slug);

    const rawPhone =
      typeof raw.phoneDigits === 'string'
        ? raw.phoneDigits
        : typeof raw.phone === 'string'
          ? raw.phone
          : undefined;
    const phoneDigits = normalizePhoneDigits(rawPhone);
    const aliases = normalizeAliases(raw.aliases, displayName);
    const trivia = typeof raw.trivia === 'string' ? raw.trivia.trim() : '';

    entries.push({
      slug,
      displayName,
      role,
      phoneDigits,
      aliases,
      trivia,
    });
  }

  return entries;
}

/**
 * Loads community trivia seed entries from a local JSON file if it exists.
 * Returns an empty array when the optional seed file is absent.
 */
export function loadCommunitySeedFile(seedPath: string, logger?: Logger): CommunitySeedEntry[] {
  const trimmedPath = seedPath.trim();
  if (!trimmedPath || !fs.existsSync(trimmedPath)) {
    logger?.debug({ seedPath: trimmedPath }, 'Optional community seed file not found; skipping.');
    return [];
  }

  try {
    const rawJson = fs.readFileSync(trimmedPath, 'utf8');
    const entries = parseCommunitySeedJson(rawJson);
    logger?.info(
      { seedPath: trimmedPath, count: entries.length },
      'Loaded local community trivia seed entries.',
    );
    return entries;
  } catch (err: unknown) {
    logger?.warn({ err, seedPath: trimmedPath }, 'Failed to parse community seed file.');
    return [];
  }
}

/**
 * Upserts seed entries into `community_trivia` without wiping existing non-empty trivia
 * when a seed entry currently leaves `trivia` blank.
 */
export function seedCommunityTrivia(
  db: DatabaseSync,
  entries: readonly CommunitySeedEntry[],
  nowMs: number = Date.now(),
): number {
  if (entries.length === 0) {
    return 0;
  }

  const upsertStmt = db.prepare(`
    INSERT INTO community_trivia (
      slug, display_name, role, phone_digits, aliases_json, trivia, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      phone_digits = COALESCE(excluded.phone_digits, community_trivia.phone_digits),
      aliases_json = excluded.aliases_json,
      trivia = CASE
        WHEN excluded.trivia <> '' THEN excluded.trivia
        ELSE community_trivia.trivia
      END,
      updated_at_ms = excluded.updated_at_ms
  `);

  db.exec('BEGIN');
  try {
    for (const entry of entries) {
      upsertStmt.run(
        entry.slug,
        entry.displayName,
        entry.role,
        entry.phoneDigits ?? null,
        JSON.stringify(entry.aliases),
        entry.trivia,
        nowMs,
        nowMs,
      );
    }
    db.exec('COMMIT');
  } catch (err: unknown) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw err;
  }

  return entries.length;
}
