import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCommunityLoreContext } from '../src/brain/communityLore.js';
import { classifyBrainMode, inferPreferredReplyLanguage } from '../src/brain/intent.js';
import {
  buildGeminiModelChain,
  buildThinkingConfig,
  formatStructuredPayload,
  parseStructuredBrainPayload,
} from '../src/brain/llmClient.js';
import { parseRssItems, selectRelevantArticles } from '../src/brain/newsGrounder.js';
import { buildSystemInstruction, resolveTimeContext } from '../src/brain/persona.js';
import { buildUserTurnPrompt } from '../src/brain/promptBuilder.js';

describe('brain/intent', () => {
  it('routes casual chat and quote-to-translate requests to Mode Santai (casual)', () => {
    assert.equal(classifyBrainMode('hello Aigis, how are you?'), 'casual');
    assert.equal(
      classifyBrainMode('translate this please', 'ペルソナ3 リロード最高！'),
      'casual',
    );
    assert.equal(classifyBrainMode('ini artinya apa ya?', '오늘 페르소나 방송 너무 재밌다'), 'casual');
  });

  it('routes latest ATLUS news, trailers, and release-date questions to Mode Serius (serious)', () => {
    assert.equal(classifyBrainMode('any latest ATLUS news today?'), 'serious');
    assert.equal(classifyBrainMode('ada berita Persona terbaru nggak?'), 'serious');
    assert.equal(classifyBrainMode('kapan rilis Persona 4 Revival?'), 'serious');
    assert.equal(classifyBrainMode('link trailer barunya dong'), 'serious');
  });

  it('defaults reply language to English unless Indonesian is used or requested', () => {
    assert.equal(inferPreferredReplyLanguage('hello Aigis!'), 'en');
    assert.equal(inferPreferredReplyLanguage('ペルソナ3最高'), 'en');
    assert.equal(inferPreferredReplyLanguage('translate this to Indonesian please'), 'id');
    assert.equal(inferPreferredReplyLanguage('menurutmu SMT V bagus nggak?'), 'id');
  });
});

describe('brain/persona and promptBuilder', () => {
  it('detects Dark Hour strictly during 00:00-00:59 WIB', () => {
    // 17:15 UTC == 00:15 WIB (next day)
    const darkHourCtx = resolveTimeContext(new Date('2026-11-16T17:15:00.000Z'));
    assert.equal(darkHourCtx.hourWib, 0);
    assert.equal(darkHourCtx.isDarkHour, true);

    // 07:00 UTC == 14:00 WIB
    const daytimeCtx = resolveTimeContext(new Date('2026-11-16T07:00:00.000Z'));
    assert.equal(daytimeCtx.hourWib, 14);
    assert.equal(daytimeCtx.isDarkHour, false);
  });

  it('injects Dark Hour alert and anti-hallucination rules cleanly into system instruction', () => {
    const darkCtx = resolveTimeContext(new Date('2026-11-16T17:15:00.000Z'));
    const casualPrompt = buildSystemInstruction('casual', darkCtx, 'en');
    assert.match(casualPrompt, /DARK HOUR/);
    assert.match(casualPrompt, /ENGLISH/);

    const seriousPrompt = buildSystemInstruction('serious', darkCtx, 'en');
    assert.match(seriousPrompt, /STRICT ANTI-HALLUCINATION RULE/);
    assert.match(seriousPrompt, /publication date/);
    assert.match(casualPrompt, /HONESTY & SINGLE-TURN RULE/);
  });

  it('injects ATLUS Jogja community lore on demand when asked about the community', () => {
    assert.equal(getCommunityLoreContext('hello Aigis, how are you?'), undefined);

    const lore = getCommunityLoreContext('Ceritain soal Komunitas ATLUS Jogja dong');
    assert.ok(lore);
    assert.match(lore, /21 October 2026 at 20:19 WIB/);
    assert.match(lore, /early September 2026/);

    const prompt = buildUserTurnPrompt(
      {
        senderName: 'Zhafir',
        senderJid: '628111@s.whatsapp.net',
        promptText: 'What is ATLUS Jogja Community?',
      },
      'casual',
    );
    assert.match(prompt, /VERIFIED LOCAL COMMUNITY PROFILE/);
  });

  it('formats quoted message context and verified news articles in user turn prompt', () => {
    const prompt = buildUserTurnPrompt(
      {
        senderName: 'Zhafir',
        senderJid: '628111@s.whatsapp.net',
        promptText: '',
        quotedText: '明日のATLUS配信が楽しみ！',
        quotedParticipantLabel: 'Member (628222)',
      },
      'serious',
      [
        {
          title: 'Persona 3 Reload Update Announced',
          url: 'https://personacentral.com/p3r-update/',
          publishedAt: '15 Nov 2026',
          publishedTimestampMs: 1794700800000,
          source: 'Persona Central',
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    );

    assert.match(prompt, /Quoted message \(from Member \(628222\) that Zhafir replied to\)/);
    assert.match(prompt, /明日のATLUS配信が楽しみ！/);
    assert.match(prompt, /\[15 Nov 2026\] \(Persona Central\) Persona 3 Reload Update Announced/);
    assert.match(prompt, /YouTube: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  });
});

describe('brain/newsGrounder', () => {
  it('parses CDATA RSS items, decodes XML entities, and extracts YouTube URLs', () => {
    const sampleXml = `
      <rss><channel>
        <item>
          <title><![CDATA[ATLUS &#038; Persona Live Trailer Revealed]]></title>
          <link>https://personacentral.com/atlus-trailer/</link>
          <pubDate>Sun, 15 Nov 2026 10:00:00 +0000</pubDate>
          <content:encoded><![CDATA[<p>Watch:</p><iframe src="https://www.youtube.com/embed/abc123XYZ99"></iframe>]]></content:encoded>
        </item>
        <item>
          <title>Metaphor ReFantazio Patch Notes</title>
          <link>https://www.gematsu.com/metaphor-patch</link>
          <pubDate>Tue, 10 Nov 2026 08:00:00 +0000</pubDate>
        </item>
      </channel></rss>
    `;

    const items = parseRssItems(sampleXml, 'Persona Central');
    assert.equal(items.length, 2);
    assert.equal(items[0]?.title, 'ATLUS & Persona Live Trailer Revealed');
    assert.equal(items[0]?.videoUrl, 'https://www.youtube.com/watch?v=abc123XYZ99');
    assert.match(items[0]?.publishedAt ?? '', /Nov 2026/);

    const ranked = selectRelevantArticles(items, 'metaphor patch update', 2);
    assert.equal(ranked[0]?.title, 'Metaphor ReFantazio Patch Notes');
  });
});

describe('brain/llmClient formatting & parsing', () => {
  it('parses fenced JSON safely and formats translations for group chat', () => {
    const raw = `\`\`\`json
    {
      "detectedInputLanguage": "ja",
      "needsTranslationDisplay": true,
      "translationText": "I am looking forward to tomorrow's ATLUS stream!",
      "replyLanguage": "en",
      "reply": "Understood. I also await the transmission, for sure!"
    }
    \`\`\``;

    const parsed = parseStructuredBrainPayload(raw);
    assert.ok(parsed);
    assert.equal(parsed.needsTranslationDisplay, true);

    const formatted = formatStructuredPayload(parsed);
    assert.equal(
      formatted,
      '📡 *[Translation]*: "I am looking forward to tomorrow\'s ATLUS stream!"\n\nUnderstood. I also await the transmission, for sure!',
    );
  });

  it('returns undefined safely for malformed JSON', () => {
    assert.equal(parseStructuredBrainPayload('not json at all'), undefined);
    assert.equal(parseStructuredBrainPayload('{"reply": "   "}'), undefined);
  });

  it('builds discrete thinkingLevel for Gemini 3.x and thinkingBudget for Gemini 2.5', () => {
    assert.deepEqual(buildThinkingConfig('gemini-3.8-flash'), { thinkingLevel: 'LOW' });
    assert.deepEqual(buildThinkingConfig('gemini-2.5-flash'), { thinkingBudget: 0 });
  });

  it('deduplicates primary and fallback Gemini models cleanly', () => {
    assert.deepEqual(
      buildGeminiModelChain('gemini-3.8-flash', [
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
      ]),
      ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    );
  });
});
