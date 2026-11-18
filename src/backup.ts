import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/env.js';

export interface BackupRuntimeOptions {
  readonly dbPath: string;
  readonly waAuthDir: string;
  readonly communitySeedPath?: string | undefined;
  readonly backupsDir: string;
  readonly now?: Date | undefined;
}

export interface BackupRuntimeResult {
  readonly backupDir: string;
  readonly backedUpItems: readonly string[];
}

function formatBackupTimestamp(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

function checkpointSqliteDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    if (db.isOpen) {
      db.close();
    }
  }
}

/**
 * Safely snapshots `aigis.db` (flushing WAL first), `community_seed.local.json`,
 * and WhatsApp `auth_info/` into a timestamped folder inside `backupsDir`.
 */
export function createRuntimeBackup(options: BackupRuntimeOptions): BackupRuntimeResult {
  const timestamp = formatBackupTimestamp(options.now ?? new Date());
  const backupDir = path.join(options.backupsDir, `aigis-backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const backedUpItems: string[] = [];

  if (options.dbPath && options.dbPath !== ':memory:' && fs.existsSync(options.dbPath)) {
    checkpointSqliteDatabase(options.dbPath);
    const dataTargetDir = path.join(backupDir, 'data');
    fs.mkdirSync(dataTargetDir, { recursive: true });
    const dbTarget = path.join(dataTargetDir, path.basename(options.dbPath));
    fs.copyFileSync(options.dbPath, dbTarget);
    backedUpItems.push(dbTarget);
  }

  if (options.communitySeedPath && fs.existsSync(options.communitySeedPath)) {
    const dataTargetDir = path.join(backupDir, 'data');
    fs.mkdirSync(dataTargetDir, { recursive: true });
    const seedTarget = path.join(dataTargetDir, path.basename(options.communitySeedPath));
    fs.copyFileSync(options.communitySeedPath, seedTarget);
    backedUpItems.push(seedTarget);
  }

  if (options.waAuthDir && fs.existsSync(options.waAuthDir)) {
    const authTargetDir = path.join(backupDir, 'auth_info');
    fs.cpSync(options.waAuthDir, authTargetDir, { recursive: true });
    backedUpItems.push(authTargetDir);
  }

  return {
    backupDir,
    backedUpItems,
  };
}

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectExecution) {
  const config = loadConfig();
  const result = createRuntimeBackup({
    dbPath: config.dbPath,
    waAuthDir: config.waAuthDir,
    communitySeedPath: config.communitySeedPath,
    backupsDir: 'backups',
  });

  console.log(
    JSON.stringify({
      status: 'ok',
      backupDir: result.backupDir,
      itemCount: result.backedUpItems.length,
      backedUpItems: result.backedUpItems,
    }),
  );
}
