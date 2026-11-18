import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  loadCommunitySeedFile,
  parseCommunitySeedJson,
  seedCommunityTrivia,
} from '../src/memory/communitySeed.js';
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  closeMemoryDatabase,
  getSchemaVersion,
  migrateMemoryDatabase,
  openMemoryDatabase,
} from '../src/memory/database.js';

describe('memory/database', () => {
  it('initializes schema tables and migrations idempotently in memory', () => {
    const db = openMemoryDatabase(':memory:');
    try {
      assert.equal(getSchemaVersion(db), CURRENT_MEMORY_SCHEMA_VERSION);

      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

      assert.deepEqual(
        tables.map((row) => row.name),
        [
          'community_trivia',
          'group_messages',
          'group_settings',
          'member_memories',
          'schema_migrations',
        ],
      );

      // Running migrateMemoryDatabase again must remain a clean no-op.
      migrateMemoryDatabase(db);
      assert.equal(getSchemaVersion(db), CURRENT_MEMORY_SCHEMA_VERSION);
    } finally {
      closeMemoryDatabase(db);
    }
  });

  it('creates missing parent directories when opening a file-backed database', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigis-db-test-'));
    const dbFile = path.join(tempDir, 'nested', 'aigis.db');

    const db = openMemoryDatabase(dbFile);
    try {
      assert.equal(fs.existsSync(dbFile), true);
      assert.equal(getSchemaVersion(db), CURRENT_MEMORY_SCHEMA_VERSION);
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('memory/communitySeed', () => {
  it('normalizes phone digits and deduplicates aliases when parsing seed JSON', () => {
    const entries = parseCommunitySeedJson(
      JSON.stringify([
        {
          slug: 'Founder Alpha',
          displayName: 'Alpha',
          role: 'Founder',
          phone: '+62 800-0000-0001',
          aliases: ['Alpha', 'AL', 'alpha'],
          trivia: '   ',
        },
        {
          displayName: 'Beta',
          role: 'Co-Founder',
          phoneDigits: '+62 800-0000-0002',
          aliases: ['betabot'],
          trivia: 'Co-Founder & resident Jack Frost fan.',
        },
      ]),
    );

    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      slug: 'founder-alpha',
      displayName: 'Alpha',
      role: 'Founder',
      phoneDigits: '6280000000001',
      aliases: ['alpha', 'al'],
      trivia: '',
    });
    assert.deepEqual(entries[1], {
      slug: 'beta',
      displayName: 'Beta',
      role: 'Co-Founder',
      phoneDigits: '6280000000002',
      aliases: ['beta', 'betabot'],
      trivia: 'Co-Founder & resident Jack Frost fan.',
    });
  });

  it('returns an empty array when optional seed file does not exist and reads valid files', () => {
    const missing = loadCommunitySeedFile(path.join(os.tmpdir(), 'definitely-missing-seed.json'));
    assert.deepEqual(missing, []);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigis-seed-test-'));
    const seedFile = path.join(tempDir, 'seed.json');
    try {
      fs.writeFileSync(
        seedFile,
        JSON.stringify([
          {
            slug: 'gamma',
            displayName: 'Gamma',
            role: 'Co-Founder',
            phone: '+62 800-0000-0003',
            trivia: 'Event organizer.',
          },
        ]),
        'utf8',
      );
      const loaded = loadCommunitySeedFile(seedFile);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.slug, 'gamma');
      assert.equal(loaded[0]?.phoneDigits, '6280000000003');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('upserts trivia without clearing existing non-empty trivia when re-seeded with blank trivia', () => {
    const db = openMemoryDatabase(':memory:');
    try {
      const initialCount = seedCommunityTrivia(
        db,
        [
          {
            slug: 'alpha',
            displayName: 'Alpha',
            role: 'Founder',
            phoneDigits: '6280000000001',
            aliases: ['alpha'],
            trivia: 'Original founder trivia.',
          },
          {
            slug: 'beta',
            displayName: 'Beta',
            role: 'Co-Founder',
            phoneDigits: '6280000000002',
            aliases: ['beta'],
            trivia: '',
          },
        ],
        1000,
      );
      assert.equal(initialCount, 2);

      // Re-seed: Alpha comes with blank trivia (should preserve existing), Beta gets newly added trivia.
      seedCommunityTrivia(
        db,
        [
          {
            slug: 'alpha',
            displayName: 'Alpha',
            role: 'Founder',
            phoneDigits: '6280000000001',
            aliases: ['alpha', 'leader'],
            trivia: '',
          },
          {
            slug: 'beta',
            displayName: 'Beta',
            role: 'Co-Founder',
            phoneDigits: '6280000000002',
            aliases: ['beta'],
            trivia: 'Added later after asking admin.',
          },
        ],
        2000,
      );

      const alphaRow = db
        .prepare('SELECT aliases_json, trivia, updated_at_ms FROM community_trivia WHERE slug = ?')
        .get('alpha') as { aliases_json: string; trivia: string; updated_at_ms: number };
      const betaRow = db
        .prepare('SELECT trivia, updated_at_ms FROM community_trivia WHERE slug = ?')
        .get('beta') as { trivia: string; updated_at_ms: number };

      assert.equal(alphaRow.trivia, 'Original founder trivia.');
      assert.deepEqual(JSON.parse(alphaRow.aliases_json), ['alpha', 'leader']);
      assert.equal(alphaRow.updated_at_ms, 2000);
      assert.equal(betaRow.trivia, 'Added later after asking admin.');
      assert.equal(betaRow.updated_at_ms, 2000);
    } finally {
      closeMemoryDatabase(db);
    }
  });
});
