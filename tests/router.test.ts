import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  extractTextAndContextInfo,
  isBotJid,
  routeIncomingMessage,
  stripBotMentionTokens,
} from '../src/whatsapp/router.js';
import type { BotIdentity } from '../src/whatsapp/types.js';

const BOT_IDENTITY: BotIdentity = {
  phoneJid: '628111222333@s.whatsapp.net',
  lidJid: '99887766554433@lid',
};

const ALLOWED_GROUPS = new Set(['120363999888777@g.us']);

describe('whatsapp/router', () => {
  it('matches bot identity across both phone JID and LID formats', () => {
    assert.equal(isBotJid('628111222333:4@s.whatsapp.net', BOT_IDENTITY), true);
    assert.equal(isBotJid('99887766554433@lid', BOT_IDENTITY), true);
    assert.equal(isBotJid('628999888777@s.whatsapp.net', BOT_IDENTITY), false);
  });

  it('strips bot mention tokens cleanly while preserving user prompt text', () => {
    const cleaned = stripBotMentionTokens('@99887766554433   halo Aigis, siapa MC Persona 3?', BOT_IDENTITY);
    assert.equal(cleaned, 'halo Aigis, siapa MC Persona 3?');
  });

  it('ignores fromMe, status broadcasts, DMs, and unwhitelisted groups', () => {
    const fromMeMsg: WAMessage = {
      key: { remoteJid: '120363999888777@g.us', fromMe: true, id: 'm1' },
      message: { conversation: '@628111222333 test' },
    };
    assert.deepEqual(routeIncomingMessage(fromMeMsg, BOT_IDENTITY, ALLOWED_GROUPS), {
      matched: false,
      reason: 'from_me',
    });

    const dmMsg: WAMessage = {
      key: { remoteJid: '628999000111@s.whatsapp.net', fromMe: false, id: 'm2' },
      message: { conversation: 'halo' },
    };
    assert.deepEqual(routeIncomingMessage(dmMsg, BOT_IDENTITY, ALLOWED_GROUPS), {
      matched: false,
      reason: 'not_group',
    });

    const otherGroupMsg: WAMessage = {
      key: { remoteJid: '120363000000111@g.us', fromMe: false, id: 'm3', participant: '628555@s.whatsapp.net' },
      message: { conversation: 'hello' },
    };
    assert.deepEqual(routeIncomingMessage(otherGroupMsg, BOT_IDENTITY, ALLOWED_GROUPS), {
      matched: false,
      reason: 'group_not_whitelisted',
      groupJid: '120363000000111@g.us',
    });
  });

  it('triggers on @lid mention inside an ephemeralMessage wrapper and captures quoted context', () => {
    const msg: WAMessage = {
      key: {
        remoteJid: '120363999888777@g.us',
        fromMe: false,
        id: 'm4',
        participant: '112233445566@lid',
        participantAlt: '628555666777@s.whatsapp.net',
      },
      pushName: 'Zhafir',
      messageTimestamp: 1794816000,
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: {
              text: '@99887766554433 jelasin maksud pesan ini dong',
              contextInfo: {
                mentionedJid: ['99887766554433@lid'],
                stanzaId: 'orig-1',
                participant: '554433221100@lid',
                quotedMessage: {
                  conversation: 'Orgia Mode bikin Aigis overheat.',
                },
              },
            },
          },
        },
      },
    };

    const decision = routeIncomingMessage(msg, BOT_IDENTITY, ALLOWED_GROUPS);
    assert.equal(decision.matched, true);
    if (!decision.matched) return;

    assert.equal(decision.trigger.triggerReason, 'mention');
    assert.equal(decision.trigger.senderName, 'Zhafir');
    assert.equal(decision.trigger.senderAltJid, '628555666777@s.whatsapp.net');
    assert.equal(decision.trigger.cleanPromptText, 'jelasin maksud pesan ini dong');
    assert.deepEqual(decision.trigger.quotedContext, {
      stanzaId: 'orig-1',
      participantJid: '554433221100@lid',
      text: 'Orgia Mode bikin Aigis overheat.',
    });
  });

  it('triggers when a group member replies directly to Aigis without @mention', () => {
    const msg: WAMessage = {
      key: {
        remoteJid: '120363999888777@g.us',
        fromMe: false,
        id: 'm5',
        participant: '628555666777@s.whatsapp.net',
      },
      pushName: 'Makoto',
      message: {
        extendedTextMessage: {
          text: 'Thank you, Aigis!',
          contextInfo: {
            stanzaId: 'bot-msg-1',
            participant: '628111222333@s.whatsapp.net',
            quotedMessage: {
              conversation: 'Systems online.',
            },
          },
        },
      },
    };

    const decision = routeIncomingMessage(msg, BOT_IDENTITY, ALLOWED_GROUPS);
    assert.equal(decision.matched, true);
    if (!decision.matched) return;

    assert.equal(decision.trigger.triggerReason, 'reply_to_bot');
    assert.equal(decision.trigger.cleanPromptText, 'Thank you, Aigis!');
  });

  it('extracts captions from media messages with mentions', () => {
    const payload = extractTextAndContextInfo({
      imageMessage: {
        caption: '@628111222333 ini Persona siapa?',
        contextInfo: {
          mentionedJid: ['628111222333@s.whatsapp.net'],
        },
      },
    });

    assert.equal(payload.text, '@628111222333 ini Persona siapa?');
    assert.deepEqual(payload.contextInfo?.mentionedJid, ['628111222333@s.whatsapp.net']);
  });
});
