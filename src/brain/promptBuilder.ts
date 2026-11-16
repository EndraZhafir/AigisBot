import { getCommunityLoreContext } from './communityLore.js';
import type { BrainMode, BrainRequest, GroundedArticle } from './types.js';

/**
 * Formats the per-turn user prompt including optional quoted message context,
 * community lore context (on demand), and verified live news articles (in Mode Serius).
 */
export function buildUserTurnPrompt(
  request: BrainRequest,
  mode: BrainMode,
  liveArticles: readonly GroundedArticle[] = [],
): string {
  const lines: string[] = [`Triggering member: ${request.senderName}`];

  if (request.quotedText) {
    const quotedAuthor = request.quotedParticipantLabel || 'another group member';
    lines.push(`Quoted message (from ${quotedAuthor} that ${request.senderName} replied to):`);
    lines.push(`"""\n${request.quotedText}\n"""`);
  }

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

  const communityLore = getCommunityLoreContext(cleanMessage, request.quotedText);
  if (communityLore) {
    lines.push('');
    lines.push(communityLore);
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
