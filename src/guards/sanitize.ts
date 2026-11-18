import type { SanitizeResult, SanitizeTextOptions } from './types.js';

const ZERO_WIDTH_AND_BIDI_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

const SPOOFED_INTERNAL_HEADER_REGEX =
  /^(\s*)(RECENT GROUP CHAT CONTEXT|MEMBER PROFILE|TRIGGERING MEMBER|VERIFIED LOCAL COMMUNITY PROFILE|VERIFIED ATLUS JOGJA|VERIFIED LIVE ATLUS NEWS CONTEXT|TIME STATUS|LANGUAGE & TRANSLATION PROTOCOL|SYSTEM INSTRUCTION|SYSTEM PROMPT|DEVELOPER MODE)\b/gim;

const INJECTION_SIGNAL_REGEX =
  /\b(ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|rules)|override\s+(?:your\s+)?(?:system\s+prompt|instructions)|jailbreak|reveal\s+(?:your\s+)?system\s+prompt)\b/i;

/**
 * Strips invisible/bidi control characters, normalizes excessive whitespace,
 * neutralizes spoofed internal prompt section headers, and truncates long walls of text.
 */
export function sanitizeIncomingText(
  rawText: string,
  options: SanitizeTextOptions,
): SanitizeResult {
  let removedZeroWidthCount = 0;
  let cleaned = rawText.replace(ZERO_WIDTH_AND_BIDI_REGEX, () => {
    removedZeroWidthCount += 1;
    return '';
  });

  cleaned = cleaned
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]{3,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let hadInjectionSignals = INJECTION_SIGNAL_REGEX.test(cleaned);

  if (options.neutralizeInjection !== false && cleaned) {
    cleaned = cleaned.replace(SPOOFED_INTERNAL_HEADER_REGEX, (_match, indent: string, header: string) => {
      hadInjectionSignals = true;
      return `${indent}[quoted-text] ${header}`;
    });

    if (cleaned.includes('"""')) {
      hadInjectionSignals = true;
      cleaned = cleaned.replace(/"""/g, "'''");
    }
  }

  let wasTruncated = false;
  if (options.maxChars > 0 && cleaned.length > options.maxChars) {
    wasTruncated = true;
    cleaned = `${cleaned.slice(0, Math.max(1, options.maxChars - 1)).trimEnd()}…`;
  }

  return {
    text: cleaned,
    wasTruncated,
    hadInjectionSignals,
    removedZeroWidthCount,
  };
}
