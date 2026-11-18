import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, normalizePhoneDigits, parseCsvSet } from '../src/config/env.js';

describe('config/env', () => {
  it('parses comma-separated strings into a trimmed Set', () => {
    const result = parseCsvSet(' 120363001@g.us , , 120363002@g.us ');
    assert.deepEqual([...result], ['120363001@g.us', '120363002@g.us']);
    assert.equal(parseCsvSet(undefined).size, 0);
  });

  it('normalizes phone strings to digits only', () => {
    assert.equal(normalizePhoneDigits('+62 812-3456-7890'), '6281234567890');
    assert.equal(normalizePhoneDigits('   '), undefined);
    assert.equal(normalizePhoneDigits(undefined), undefined);
  });

  it('loads default config cleanly when optional vars are omitted', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.waAuthDir, 'auth_info');
    assert.equal(config.waPairingPhone, undefined);
    assert.equal(config.allowedGroupJids.size, 0);
    assert.equal(config.geminiApiKey, undefined);
    assert.equal(config.geminiModel, 'gemini-3.5-flash-lite');
    assert.deepEqual(config.geminiFallbackModels, ['gemini-3.1-flash-lite']);
    assert.equal(config.geminiTimeoutMs, 10_000);
    assert.equal(config.enableSearchGrounding, false);
    assert.equal(config.dbPath, 'data/aigis.db');
    assert.equal(config.groupContextWindowSize, 12);
    assert.equal(config.groupMessageRetentionLimit, 100);
    assert.equal(config.communitySeedPath, 'data/community_seed.local.json');
    assert.equal(config.userCooldownMs, 15_000);
    assert.equal(config.groupCooldownMs, 5_000);
  });

  it('parses owners, allowed groups, LLM settings, and pairing phone from env', () => {
    const config = loadConfig({
      WA_PAIRING_PHONE: '+62 811-2233-4455',
      ALLOWED_GROUP_JIDS: '12345@g.us, 67890@g.us',
      BOT_OWNER_NUMBERS: '+62 899-0000-1111',
      GEMINI_API_KEY: ' AIzaTestKey ',
      GEMINI_MODEL: 'gemini-2.5-flash',
      ENABLE_SEARCH_GROUNDING: 'false',
      GROUP_CONTEXT_WINDOW_SIZE: '15',
      GROUP_MESSAGE_RETENTION_LIMIT: '200',
      COMMUNITY_SEED_PATH: 'data/custom_seed.json',
      USER_COOLDOWN_MS: '20000',
    });

    assert.equal(config.waPairingPhone, '6281122334455');
    assert.deepEqual([...config.allowedGroupJids], ['12345@g.us', '67890@g.us']);
    assert.deepEqual([...config.botOwnerNumbers], ['6289900001111']);
    assert.equal(config.geminiApiKey, 'AIzaTestKey');
    assert.equal(config.enableSearchGrounding, false);
    assert.equal(config.groupContextWindowSize, 15);
    assert.equal(config.groupMessageRetentionLimit, 200);
    assert.equal(config.communitySeedPath, 'data/custom_seed.json');
    assert.equal(config.userCooldownMs, 20_000);
    assert.equal(config.groupCooldownMs, 5_000);
  });
});
