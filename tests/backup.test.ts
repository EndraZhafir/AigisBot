import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRuntimeBackup } from '../src/backup.js';
import { closeMemoryDatabase, openMemoryDatabase } from '../src/memory/database.js';
import { GroupBufferRepository } from '../src/memory/groupBufferRepo.js';

describe('backup/createRuntimeBackup', () => {
  it('checkpoints WAL sqlite DB, copies community seed and auth_info into a timestamped backup folder', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aigis-backup-test-'));
    try {
      const dbPath = path.join(tempRoot, 'data', 'aigis.db');
      const seedPath = path.join(tempRoot, 'data', 'community_seed.local.json');
      const authDir = path.join(tempRoot, 'auth_info');
      const backupsDir = path.join(tempRoot, 'backups');

      const db = openMemoryDatabase(dbPath);
      const buffer = new GroupBufferRepository(db);
      buffer.saveMessage({
        groupJid: '120363000000001@g.us',
        messageId: 'm-1',
        senderJid: '6280000000001@s.whatsapp.net',
        senderName: 'Tester',
        text: 'Persist this across WAL checkpoint',
        timestampMs: 1000,
      });
      closeMemoryDatabase(db);

      fs.writeFileSync(seedPath, '[]', 'utf8');
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"me":{"id":"test"}}', 'utf8');

      const result = createRuntimeBackup({
        dbPath,
        waAuthDir: authDir,
        communitySeedPath: seedPath,
        backupsDir,
        now: new Date('2026-11-18T16:30:05.000Z'), // 23:30:05 WIB
      });

      assert.equal(path.basename(result.backupDir), 'aigis-backup-20261118-233005');
      assert.equal(result.backedUpItems.length, 3);
      assert.equal(fs.existsSync(path.join(result.backupDir, 'data', 'aigis.db')), true);
      assert.equal(
        fs.existsSync(path.join(result.backupDir, 'data', 'community_seed.local.json')),
        true,
      );
      assert.equal(fs.existsSync(path.join(result.backupDir, 'auth_info', 'creds.json')), true);

      // Verify copied DB contains the checkpointed row intact.
      const restoredDb = openMemoryDatabase(path.join(result.backupDir, 'data', 'aigis.db'));
      try {
        const restoredBuffer = new GroupBufferRepository(restoredDb);
        assert.equal(
          restoredBuffer.findMessageById('120363000000001@g.us', 'm-1')?.text,
          'Persist this across WAL checkpoint',
        );
      } finally {
        closeMemoryDatabase(restoredDb);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
