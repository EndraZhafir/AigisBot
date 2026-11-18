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
import { MemoryContextService } from '../src/memory/contextService.js';
import { GroupBufferRepository } from '../src/memory/groupBufferRepo.js';
import {
  MemberMemoryRepository,
  calculateBondLevel,
  extractPhoneDigitsFromJid,
} from '../src/memory/memberMemoryRepo.js';

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

describe('memory/groupBufferRepo', () => {
  it('saves messages idempotently, returns chronological sliding window, and prunes old rows per group', () => {
    const db = openMemoryDatabase(':memory:');
    try {
      const repo = new GroupBufferRepository(db);
      const groupA = '120363000000001@g.us';
      const groupB = '120363000000002@g.us';

      for (let i = 1; i <= 6; i += 1) {
        repo.saveMessage(
          {
            groupJid: groupA,
            messageId: `msg-${i}`,
            senderJid: '6280000000001@s.whatsapp.net',
            senderName: 'MemberA',
            text: `Message ${i}`,
            timestampMs: 10_000 + i * 1_000,
          },
          4,
        );
      }

      // Duplicate messageId should be ignored cleanly.
      repo.saveMessage(
        {
          groupJid: groupA,
          messageId: 'msg-6',
          senderJid: '6280000000001@s.whatsapp.net',
          senderName: 'MemberA',
          text: 'Duplicate attempt',
          timestampMs: 16_000,
        },
        4,
      );

      repo.saveMessage(
        {
          groupJid: groupB,
          messageId: 'other-1',
          senderJid: '6280000000002@s.whatsapp.net',
          senderName: 'MemberB',
          text: 'Separate group chat',
          timestampMs: 20_000,
        },
        4,
      );

      assert.equal(repo.countGroupMessages(groupA), 4);
      assert.equal(repo.countGroupMessages(groupB), 1);

      const windowExcludingCurrent = repo.getRecentMessages(groupA, 3, 'msg-6');
      assert.deepEqual(
        windowExcludingCurrent.map((m) => m.messageId),
        ['msg-3', 'msg-4', 'msg-5'],
      );
      assert.equal(repo.findMessageById(groupA, 'msg-6')?.text, 'Message 6');
    } finally {
      closeMemoryDatabase(db);
    }
  });
});

describe('memory/memberMemoryRepo and contextService', () => {
  it('extracts phone digits only from phone JIDs and computes Social Link bond levels', () => {
    assert.equal(extractPhoneDigitsFromJid('6280000000001:4@s.whatsapp.net'), '6280000000001');
    assert.equal(extractPhoneDigitsFromJid('99887766554433@lid'), undefined);
    assert.equal(extractPhoneDigitsFromJid('120363000000001@g.us'), undefined);

    assert.equal(calculateBondLevel(0), 1);
    assert.equal(calculateBondLevel(1), 2);
    assert.equal(calculateBondLevel(4), 3);
    assert.equal(calculateBondLevel(81), 10);
    assert.equal(calculateBondLevel(999), 10);
  });

  it('unifies @lid and phone identities, resolves trivia without leaking numbers, and records bot replies', () => {
    const db = openMemoryDatabase(':memory:');
    try {
      seedCommunityTrivia(
        db,
        [
          {
            slug: 'alpha',
            displayName: 'Alpha',
            role: 'Founder',
            phoneDigits: '6280000000001',
            aliases: ['alpha', 'leader'],
            trivia: 'Founder who organized the very first meetup.',
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
        5_000,
      );

      const groupBuffer = new GroupBufferRepository(db);
      const memberRepo = new MemberMemoryRepository(db);
      const contextService = new MemoryContextService(groupBuffer, memberRepo, 10, 50);
      const groupJid = '120363999000111@g.us';

      // Step 1: User posts casual message from @lid without alt JID yet.
      contextService.recordObservedMessage({
        groupJid,
        messageId: 'm-1',
        senderJid: '111222333444@lid',
        senderName: 'AlphaOldName',
        text: 'Guys, besok kita bahas Persona 3 Reload!',
        timestampMs: 1_000,
      });

      const passiveProfile = memberRepo.getMemberByIdentity(groupJid, '111222333444@lid');
      assert.equal(passiveProfile?.interactionCount, 0);
      assert.equal(passiveProfile?.bondLevel, 1);

      // Step 2: Same user later triggers Aigis with resolved senderAltJid (phone JID).
      contextService.recordObservedMessage({
        groupJid,
        messageId: 'm-2',
        senderJid: '111222333444@lid',
        senderAltJid: '6280000000001@s.whatsapp.net',
        senderName: 'Alpha',
        text: 'siapa saja founder komunitas ini?',
        timestampMs: 2_000,
      });

      const ctx = contextService.preparePromptContext({
        groupJid,
        currentMessageId: 'm-2',
        senderJid: '111222333444@lid',
        senderAltJid: '6280000000001@s.whatsapp.net',
        senderName: 'Alpha',
        promptText: 'siapa saja founder komunitas ini?',
        quotedStanzaId: 'm-1',
        quotedParticipantJid: '111222333444@lid',
        timestampMs: 2_000,
      });

      assert.equal(ctx.memberProfile.displayName, 'Alpha');
      assert.equal(ctx.memberProfile.communityRole, 'Founder');
      assert.equal(ctx.memberProfile.interactionCount, 1);
      assert.equal(ctx.memberProfile.bondLevel, 2);
      assert.equal(ctx.quotedParticipantLabel, 'AlphaOldName');
      assert.deepEqual(
        ctx.recentMessages.map((m) => m.text),
        ['Guys, besok kita bahas Persona 3 Reload!'],
      );
      assert.deepEqual(ctx.matchedTrivia, [
        {
          displayName: 'Alpha',
          role: 'Founder',
          trivia: 'Founder who organized the very first meetup.',
        },
        {
          displayName: 'Beta',
          role: 'Co-Founder',
          trivia: '',
        },
      ]);

      // Unified lookup by phone JID now hits the upgraded member row.
      const unified = memberRepo.getMemberByIdentity(groupJid, '6280000000001@s.whatsapp.net');
      assert.equal(unified?.memberKey, 'pn:6280000000001');
      assert.equal(unified?.interactionCount, 1);

      // Step 3: Save bot reply and verify it enters the sliding window.
      contextService.recordBotReply({
        groupJid,
        messageId: 'bot-1',
        botJid: '6289999999999@s.whatsapp.net',
        text: 'Founder komunitas ini adalah Alpha dan Beta.',
        timestampMs: 3_000,
      });

      const afterBot = groupBuffer.getRecentMessages(groupJid, 10);
      assert.equal(afterBot.length, 3);
      assert.equal(afterBot[2]?.isFromBot, true);
      assert.equal(afterBot[2]?.senderName, 'Aigis');

      // Plural English queries ("founders", "co-founders", "admins") must also match broad trivia.
      const pluralMatches = memberRepo.findMatchingTrivia('Do you know who the founders are?');
      assert.equal(pluralMatches.length, 2);
      const adminPluralMatches = memberRepo.findMatchingTrivia('Who are the co-founders and admins?');
      assert.equal(adminPluralMatches.length, 2);
    } finally {
      closeMemoryDatabase(db);
    }
  });
});

