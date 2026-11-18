import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from 'pino';

export const CURRENT_MEMORY_SCHEMA_VERSION = 1;

const MIGRATION_V1_SQL = `
  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_alt_jid TEXT,
    sender_phone TEXT,
    sender_name TEXT NOT NULL,
    text TEXT NOT NULL,
    is_from_bot INTEGER NOT NULL DEFAULT 0,
    timestamp_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(group_jid, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_messages_window
    ON group_messages (group_jid, timestamp_ms DESC, id DESC);

  CREATE TABLE IF NOT EXISTS member_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid TEXT NOT NULL,
    member_key TEXT NOT NULL,
    primary_jid TEXT NOT NULL,
    alt_jid TEXT,
    phone_digits TEXT,
    display_name TEXT NOT NULL,
    preferred_language TEXT,
    favorite_games TEXT,
    notes TEXT,
    interaction_count INTEGER NOT NULL DEFAULT 0,
    bond_level INTEGER NOT NULL DEFAULT 1,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    UNIQUE(group_jid, member_key)
  );

  CREATE INDEX IF NOT EXISTS idx_member_memories_phone
    ON member_memories (group_jid, phone_digits);

  CREATE TABLE IF NOT EXISTS community_trivia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone_digits TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    trivia TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_community_trivia_phone
    ON community_trivia (phone_digits);

  CREATE TABLE IF NOT EXISTS group_settings (
    group_jid TEXT PRIMARY KEY,
    moderation_mode TEXT NOT NULL DEFAULT 'off',
    updated_at_ms INTEGER NOT NULL
  );
`;

/**
 * Ensures the SQLite database schema is migrated up to CURRENT_MEMORY_SCHEMA_VERSION.
 */
export function migrateMemoryDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const appliedVersion = getSchemaVersion(db);
  if (appliedVersion >= CURRENT_MEMORY_SCHEMA_VERSION) {
    return;
  }

  db.exec('BEGIN');
  try {
    if (appliedVersion < 1) {
      db.exec(MIGRATION_V1_SQL);
      db.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)',
      ).run(1, Date.now());
    }
    db.exec('COMMIT');
  } catch (err: unknown) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw err;
  }
}

/**
 * Returns the highest applied schema version, or 0 if no migrations have been recorded.
 */
export function getSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number } | undefined;

  return typeof row?.version === 'number' ? row.version : 0;
}

/**
 * Opens the built-in node:sqlite database, configures safe pragmas, and runs migrations.
 */
export function openMemoryDatabase(dbPath: string, logger?: Logger): DatabaseSync {
  const normalizedPath = dbPath.trim() || ':memory:';
  const isInMemory = normalizedPath === ':memory:';

  if (!isInMemory) {
    const parentDir = path.dirname(normalizedPath);
    if (parentDir && parentDir !== '.') {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new DatabaseSync(normalizedPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  if (!isInMemory) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }

  migrateMemoryDatabase(db);
  logger?.info(
    { dbPath: normalizedPath, schemaVersion: getSchemaVersion(db) },
    'SQLite memory database ready.',
  );

  return db;
}

/**
 * Closes an open SQLite database cleanly during graceful shutdown.
 */
export function closeMemoryDatabase(db: DatabaseSync | undefined, logger?: Logger): void {
  if (!db || !db.isOpen) {
    return;
  }

  try {
    db.close();
    logger?.info('SQLite memory database closed.');
  } catch (err: unknown) {
    logger?.warn({ err }, 'Failed to close SQLite memory database cleanly.');
  }
}
