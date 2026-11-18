import type { Logger } from 'pino';
import type { GroundedArticle } from './types.js';

interface FeedSource {
  readonly name: string;
  readonly url: string;
}

const DEFAULT_ATLUS_FEEDS: readonly FeedSource[] = [
  { name: 'Persona Central', url: 'https://personacentral.com/feed/' },
  { name: 'Gematsu (ATLUS)', url: 'https://www.gematsu.com/tag/atlus/feed' },
];

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'what',
  'when',
  'about',
  'latest',
  'news',
  'update',
  'berita',
  'terbaru',
  'kabar',
  'kapan',
  'rilis',
  'soal',
  'yang',
  'ada',
  'apa',
  'game',
  'games',
  'atlus',
]);

function stripCdata(raw: string): string {
  return raw.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTagValue(block: string, tagName: string): string {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match?.[1] ? decodeXmlEntities(stripCdata(match[1])) : '';
}

function extractYoutubeUrl(block: string): string | undefined {
  const match = block.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}(?:[^\s"'<>)]*)?/i,
  );
  if (!match?.[0]) {
    return undefined;
  }

  // Normalize /embed/<id> URLs into shareable watch URLs.
  const embedMatch = match[0].match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i);
  if (embedMatch?.[1]) {
    return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
  }
  return match[0];
}

function formatReadableDate(rawDate: string): { formatted: string; timestampMs: number } {
  const parsedMs = Date.parse(rawDate);
  if (!Number.isFinite(parsedMs)) {
    return { formatted: rawDate || 'Unknown date', timestampMs: 0 };
  }

  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(parsedMs));

  return { formatted, timestampMs: parsedMs };
}

/**
 * Parses `<item>` blocks from an RSS 2.0 XML payload into normalized GroundedArticle entries.
 */
export function parseRssItems(xml: string, sourceName: string): GroundedArticle[] {
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const articles: GroundedArticle[] = [];

  for (const itemXml of itemMatches) {
    const title = extractTagValue(itemXml, 'title');
    const url = extractTagValue(itemXml, 'link');
    const pubDateRaw = extractTagValue(itemXml, 'pubDate');
    if (!title || !url) {
      continue;
    }

    const { formatted, timestampMs } = formatReadableDate(pubDateRaw);
    const videoUrl = extractYoutubeUrl(itemXml);

    articles.push({
      title,
      url,
      publishedAt: formatted,
      publishedTimestampMs: timestampMs,
      source: sourceName,
      videoUrl,
    });
  }

  return articles;
}

/**
 * Ranks articles by query keyword overlap and publication recency.
 */
export function selectRelevantArticles(
  articles: readonly GroundedArticle[],
  query: string,
  limit = 6,
): GroundedArticle[] {
  const keywords = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));

  const seenUrls = new Set<string>();
  const uniqueArticles: GroundedArticle[] = [];
  for (const article of articles) {
    if (!seenUrls.has(article.url)) {
      seenUrls.add(article.url);
      uniqueArticles.push(article);
    }
  }

  return uniqueArticles
    .map((article) => {
      const haystack = article.title.toLowerCase();
      let keywordHits = 0;
      for (const kw of keywords) {
        if (haystack.includes(kw)) {
          keywordHits += 1;
        }
      }
      return { article, keywordHits };
    })
    .sort((a, b) => {
      if (b.keywordHits !== a.keywordHits) {
        return b.keywordHits - a.keywordHits;
      }
      return b.article.publishedTimestampMs - a.article.publishedTimestampMs;
    })
    .slice(0, limit)
    .map((entry) => entry.article);
}

/**
 * Fetches and caches live ATLUS-oriented RSS news feeds with zero API quota cost.
 */
export class AtlusNewsGrounder {
  private cachedArticles: GroundedArticle[] = [];
  private cacheExpiresAtMs = 0;

  constructor(
    private readonly cacheTtlMs: number,
    private readonly logger: Logger,
    private readonly feeds: readonly FeedSource[] = DEFAULT_ATLUS_FEEDS,
  ) {}

  async getRelevantNews(query: string, limit = 5): Promise<GroundedArticle[]> {
    const articles = await this.loadAllFeeds();
    return selectRelevantArticles(articles, query, limit);
  }

  private async loadAllFeeds(): Promise<GroundedArticle[]> {
    const nowMs = Date.now();
    if (this.cachedArticles.length > 0 && nowMs < this.cacheExpiresAtMs) {
      return this.cachedArticles;
    }

    const results = await Promise.allSettled(
      this.feeds.map(async (feed) => {
        const response = await fetch(feed.url, {
          signal: AbortSignal.timeout(4_500),
          headers: { 'User-Agent': 'AigisBot/0.1 (ATLUS Community WA Bot)' },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${feed.name}`);
        }
        const xml = await response.text();
        return parseRssItems(xml, feed.name).slice(0, 12);
      }),
    );

    const fresh: GroundedArticle[] = [];
    for (const res of results) {
      if (res.status === 'fulfilled') {
        fresh.push(...res.value);
      } else {
        this.logger.debug({ reason: res.reason }, 'Optional ATLUS RSS feed fetch failed.');
      }
    }

    if (fresh.length > 0) {
      this.cachedArticles = fresh.sort((a, b) => b.publishedTimestampMs - a.publishedTimestampMs);
      this.cacheExpiresAtMs = nowMs + this.cacheTtlMs;
    }

    return this.cachedArticles;
  }
}
