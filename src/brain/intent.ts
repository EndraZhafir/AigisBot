import type { BrainMode, TargetReplyLanguage } from './types.js';

const SERIOUS_NEWS_PATTERNS = [
  /\b(news|berita|kabar|terbaru|latest|update|updates|patch|hotfix|changelog)\b/i,
  /\b(rilis|release|released|jadwal|schedule|tanggal|date|announced|announcement|pengumuman|rumor|leak)\b/i,
  /\b(trailer|teaser|pv|video|youtube|yt|showcase|stream|direct|tgs|state of play|game awards)\b/i,
  /\b(artikel|article|link|sumber|source|sales|penjualan|dlc|expansion|remake|revival|sequel|port)\b/i,
  /\b(kapan|when does|when is|when will)\b/i,
] as const;

const TRANSLATE_REQUEST_PATTERNS = [
  /\b(translate|terjemah(?:in|kan)?|arti(?:nya|in)?|maksudnya|what does (?:this|that|it) mean)\b/i,
] as const;

const EXPLICIT_INDONESIAN_REQUEST_PATTERNS = [
  /\b(bahasa indonesia|bhs indonesia|pake?ai? (?:bhs |bahasa )?indo|jawab (?:pakai |pake )?(?:bhs |bahasa )?indo)\b/i,
  /\b(in indonesian|to indonesian|ke (?:bahasa )?indonesia|ke indo)\b/i,
  /\b(terjemah(?:in|kan)|arti(?:nya|in)|maksudnya apa)\b/i,
] as const;

const INDONESIAN_LEXICON_PATTERN =
  /\b(aku|saya|kamu|kalian|gw|gue|lu|elo|apa|siapa|kapan|kenapa|gimana|bagaimana|tolong|dong|sih|nih|tuh|ya|iya|nggak|gak|ga|tidak|bisa|mau|lagi|udah|sudah|belum|kalau|kalo|soalnya|yang|dan|atau|buat|untuk|dari|sama|ada|berita|terjemahin|artinya|maksudnya|menurutmu)\b/gi;

/**
 * Classifies an incoming request into Mode Santai (`casual`) or Mode Serius (`serious`).
 * Mode Serius activates for news, release dates, announcements, trailers, or factual updates.
 */
export function classifyBrainMode(promptText: string, quotedText?: string): BrainMode {
  const combined = `${promptText} ${quotedText ?? ''}`.trim();
  if (!combined) {
    return 'casual';
  }

  const hasNewsSignal = SERIOUS_NEWS_PATTERNS.some((pattern) => pattern.test(promptText));
  if (hasNewsSignal) {
    return 'serious';
  }

  const isTranslateAsk = TRANSLATE_REQUEST_PATTERNS.some((pattern) => pattern.test(promptText));
  if (isTranslateAsk) {
    return 'casual';
  }

  // Only inspect quotedText for news signals if the user didn't merely ping or ask to translate.
  if (promptText.length === 0 && quotedText) {
    const quotedNewsSignal = SERIOUS_NEWS_PATTERNS.some((pattern) => pattern.test(quotedText));
    if (quotedNewsSignal) {
      return 'serious';
    }
  }

  return 'casual';
}

/**
 * Determines the preferred reply language: English by default, Indonesian when written in
 * Indonesian or explicitly requested.
 */
export function inferPreferredReplyLanguage(promptText: string): TargetReplyLanguage {
  if (!promptText.trim()) {
    return 'en';
  }

  if (EXPLICIT_INDONESIAN_REQUEST_PATTERNS.some((pattern) => pattern.test(promptText))) {
    return 'id';
  }

  const matches = promptText.match(INDONESIAN_LEXICON_PATTERN) ?? [];
  return matches.length >= 2 ? 'id' : 'en';
}
