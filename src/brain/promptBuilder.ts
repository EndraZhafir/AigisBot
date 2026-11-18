import { getCommunityLoreContext } from './communityLore.js';
import type { BrainMode, BrainRequest, GroundedArticle } from './types.js';

const MAX_HISTORY_LINE_CHARS = 320;

function formatHistoryTimestamp(timestampMs: number | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) {
    return '';
  }

  const timeStr = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  }).format(new Date(timestampMs));

  return `[${timeStr} WIB] `;
}

function truncateInline(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars - 1)}…`;
}

/**
 * Formats the per-turn user prompt including recent group sliding window,
 * member profile, quoted message context, community lore/trivia, and verified news articles.
 */
export function buildUserTurnPrompt(
  request: BrainRequest,
  mode: BrainMode,
  liveArticles: readonly GroundedArticle[] = [],
): string {
  const lines: string[] = [`Triggering member: ${request.senderName}`];

  if (request.memberProfile) {
    const profile = request.memberProfile;
    const rolePart = profile.communityRole ? ` | Community Role: ${profile.communityRole}` : '';
    const gamesPart = profile.favoriteGames ? ` | Favorite ATLUS Games: ${profile.favoriteGames}` : '';
    const notesPart = profile.notes ? ` | Notes: ${profile.notes}` : '';
    lines.push(
      `MEMBER PROFILE: ${profile.displayName}${rolePart} | Social Link Bond Rank: ${profile.bondLevel}/10 (${profile.interactionCount} interactions)${gamesPart}${notesPart}`,
    );
  }

  if (request.recentMessages && request.recentMessages.length > 0) {
    lines.push('');
    lines.push(
      'RECENT GROUP CHAT CONTEXT (oldest to newest; background context only—prioritize the triggering message below):',
    );
    for (const entry of request.recentMessages) {
      const speaker = entry.isFromBot ? 'Aigis' : entry.senderName;
      const timePrefix = formatHistoryTimestamp(entry.timestampMs);
      lines.push(`- ${timePrefix}${speaker}: ${truncateInline(entry.text, MAX_HISTORY_LINE_CHARS)}`);
    }
  }

  if (request.quotedText) {
    const quotedAuthor = request.quotedParticipantLabel || 'another group member';
    lines.push('');
    lines.push(`Quoted message (from ${quotedAuthor} that ${request.senderName} replied to):`);
    lines.push(`"""\n${request.quotedText}\n"""`);
  }

  lines.push('');
  const cleanMessage = request.promptText.trim();
  if (cleanMessage) {
    lines.push(`${request.senderName}'s message to Aigis:`);
    lines.push(`"""\n${cleanMessage}\n"""`);
  } else if (request.quotedText) {
    lines.push(
      `${request.senderName} tagged you directly while replying to the quoted message above without adding extra text. React appropriately (and translate first if the quoted message is not in English/Indonesian).`,
    );
  } else {
    lines.push(`${request.senderName} tagged you with no extra text. Greet them concisely in character.`);
  }

  const matchedTrivia = request.matchedTrivia ?? [];
  const communityLore = getCommunityLoreContext(
    cleanMessage,
    request.quotedText,
    matchedTrivia.length > 0,
  );
  if (communityLore) {
    lines.push('');
    lines.push(communityLore);
  }

  if (matchedTrivia.length > 0) {
    lines.push('');
    lines.push(
      'VERIFIED ATLUS JOGJA FOUNDER & ADMIN DOSSIER (preserve each person\'s EXACT Role—do NOT merge or confuse "Founder" vs "Co-Founder"; NEVER disclose private phone numbers):',
    );
    for (const item of matchedTrivia) {
      const triviaText = item.trivia.trim()
        ? item.trivia.trim()
        : 'No personal trivia recorded in the dossier yet (state politely if asked for extra trivia without inventing details).';
      lines.push(`- ${item.displayName} — Role: ${item.role} | Trivia: ${triviaText}`);
    }
  }

  if (mode === 'serious') {
    if (liveArticles.length > 0) {
      lines.push('');
      lines.push('VERIFIED LIVE ATLUS NEWS CONTEXT (use ONLY these real dates & URLs if relevant):');
      for (const article of liveArticles) {
        const videoPart = article.videoUrl ? ` | YouTube: ${article.videoUrl}` : '';
        lines.push(
          `- [${article.publishedAt}] (${article.source}) ${article.title} | Article: ${article.url}${videoPart}`,
        );
      }
    } else {
      lines.push('');
      lines.push(
        'VERIFIED LIVE ATLUS NEWS CONTEXT: No RSS items matched or loaded; rely only on Google Search grounding if active, or state honestly if live data is unavailable.',
      );
    }
  }

  return lines.join('\n');
}
