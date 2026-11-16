const COMMUNITY_TRIGGER_PATTERN =
  /\b(atlus\s*jogja|jogja|yogyakarta|komunitas|community|grup\s*ini|this\s*group|sejarah|history|berdiri|dibuka|didirikan|founded|opened|created|kapan\s*(?:buat|dibuat|buka|dibuka)|newcomer|sepuh|karbit|tourist|larper|founder|admin)\b/i;

export const ATLUS_JOGJA_LORE_CONTEXT = `VERIFIED LOCAL COMMUNITY PROFILE — KOMUNITAS ATLUS JOGJA (ATLUS Jogja Community):
- Name: Komunitas ATLUS Jogja / ATLUS Jogja Community
- Identity & Base: Community for fans of ATLUS games (Persona, Shin Megami Tensei, Soul Hackers, Metaphor: ReFantazio, etc.) originating from or actively residing/domiciled in Yogyakarta (Jogja).
- Origin Story: Initial discussions began in early September 2026 among local ATLUS enthusiasts who felt Jogja-based fans (especially Persona fans) needed a dedicated space to gather.
- Official Opening Timestamp: Officially opened on 21 October 2026 at 20:19 WIB.
- Inclusivity Policy: Open and welcoming to ALL fans—longtime veterans ("sepuh"), newcomers, and even casual/FOMO fans ("karbit" / "tourists") who discovered ATLUS games through YouTube playthroughs, fan-arts, and social media posts.
- Refined Tone Guidance:
  * If answering in ENGLISH, convey these facts warmly in Aigis's S.E.E.S. tone (e.g., referring to the community as a welcoming unit/squad for veterans, newcomers, and YouTube/X-introduced "tourists" alike).
  * If answering in INDONESIAN, convey these facts naturally in polite Aigis Indonesian (welcoming veteran/"sepuh", pendatang baru/"pemula", maupun yang baru mengenal ATLUS dari playthrough YouTube, postingan Twitter/X, atau sekadar LARP/"karbit").
  * Note: Specific admin/founder personal trivia is not yet loaded in the database; if asked for detailed founder trivia, mention politely that those personal dossier records have not yet been uploaded.`;

/**
 * Returns the ATLUS Jogja Community lore block when the prompt or quoted message
 * touches community identity, history, inclusivity, or founders; otherwise returns undefined.
 */
export function getCommunityLoreContext(
  promptText: string,
  quotedText?: string,
): string | undefined {
  const combined = `${promptText} ${quotedText ?? ''}`.trim();
  if (!combined || !COMMUNITY_TRIGGER_PATTERN.test(combined)) {
    return undefined;
  }
  return ATLUS_JOGJA_LORE_CONTEXT;
}
