import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Candidate,
  type Schema,
  type ThinkingConfig,
} from '@google/genai';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { classifyBrainMode, inferPreferredReplyLanguage } from './intent.js';
import { AtlusNewsGrounder } from './newsGrounder.js';
import { buildSystemInstruction, resolveTimeContext } from './persona.js';
import { buildUserTurnPrompt } from './promptBuilder.js';
import type {
  BrainRequest,
  BrainResponse,
  BrainStructuredPayload,
  GroundedArticle,
} from './types.js';

const SEARCH_GROUNDING_COOLDOWN_MS = 10 * 60_000;
const MODEL_FAILURE_COOLDOWN_MS = 5 * 60_000;
const TRANSIENT_503_RETRY_DELAYS_MS = [1_500, 3_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CASUAL_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    detectedInputLanguage: { type: Type.STRING },
    needsTranslationDisplay: { type: Type.BOOLEAN },
    translationText: { type: Type.STRING },
    replyLanguage: { type: Type.STRING, enum: ['en', 'id'] },
    reply: { type: Type.STRING },
  },
  required: [
    'detectedInputLanguage',
    'needsTranslationDisplay',
    'translationText',
    'replyLanguage',
    'reply',
  ],
};

/**
 * Strips markdown code fences if a model wraps JSON inside ```json ... ``` and parses safely.
 */
export function parseStructuredBrainPayload(rawText: string): BrainStructuredPayload | undefined {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!cleaned) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(cleaned) as Partial<BrainStructuredPayload>;
    if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
      return undefined;
    }

    return {
      detectedInputLanguage:
        typeof parsed.detectedInputLanguage === 'string' ? parsed.detectedInputLanguage : 'unknown',
      needsTranslationDisplay: Boolean(parsed.needsTranslationDisplay),
      translationText:
        typeof parsed.translationText === 'string' ? parsed.translationText.trim() : '',
      replyLanguage: parsed.replyLanguage === 'id' ? 'id' : 'en',
      reply: parsed.reply.trim(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Formats a Mode Santai structured payload into a WhatsApp-ready string.
 */
export function formatStructuredPayload(payload: BrainStructuredPayload): string {
  if (payload.needsTranslationDisplay && payload.translationText) {
    const label = payload.replyLanguage === 'id' ? 'Terjemahan' : 'Translation';
    return `📡 *[${label}]*: "${payload.translationText}"\n\n${payload.reply}`;
  }
  return payload.reply;
}

/**
 * Extracts verified web grounding URLs from Gemini's groundingMetadata (when Google Search runs).
 */
export function extractGroundingUrls(candidate: Candidate | undefined): string[] {
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urls: string[] = [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri?.trim();
    if (uri && !urls.includes(uri)) {
      urls.push(uri);
    }
  }
  return urls;
}

function appendFallbackSourcesIfMissing(
  text: string,
  urls: readonly string[],
): string {
  if (urls.length === 0 || /https?:\/\//i.test(text)) {
    return text;
  }
  const sourceLines = urls.slice(0, 2).map((url) => `🔗 ${url}`);
  return `${text}\n\n${sourceLines.join('\n')}`;
}

/**
 * Gemini 3.x models use discrete `thinkingLevel` ("low"/"medium"/"high"; "minimal" is unsupported on 3.8 Flash),
 * whereas Gemini 2.5 models use `thinkingBudget`.
 */
export function buildThinkingConfig(modelName: string): ThinkingConfig {
  if (/gemini-2\.5/i.test(modelName)) {
    return { thinkingBudget: 0 };
  }
  return { thinkingLevel: ThinkingLevel.LOW };
}

/**
 * Builds the ordered, deduplicated Gemini model chain (primary followed by fallback models).
 */
export function buildGeminiModelChain(
  primaryModel: string,
  fallbackModels: readonly string[],
): string[] {
  return [...new Set([primaryModel, ...fallbackModels].map((m) => m.trim()).filter(Boolean))];
}

function getErrorInfo(err: unknown): { status: number | undefined; message: string; name: string } {
  if (err instanceof Error) {
    const withStatus = err as Error & { status?: number };
    return {
      status: typeof withStatus.status === 'number' ? withStatus.status : undefined,
      message: err.message,
      name: err.name,
    };
  }
  return { status: undefined, message: String(err), name: 'UnknownError' };
}

function shouldTryNextModel(err: unknown): boolean {
  const { status, name } = getErrorInfo(err);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }
  if (status === undefined) {
    return true;
  }
  // Retry next model on unavailable/overloaded/rate-limited/deprecated-model errors, not auth failures.
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * Orchestrates Aigis's dual-mode LLM brain: Mode Santai (roleplay + auto-translate JSON)
 * and Mode Serius (dated ATLUS news via Google Search grounding + free RSS fallback).
 */
export class AigisBrain {
  private readonly geminiClient: GoogleGenAI | undefined;
  private readonly newsGrounder: AtlusNewsGrounder;
  private searchGroundingCooldownUntilMs = 0;
  private readonly modelCooldownUntilMs = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    newsGrounder?: AtlusNewsGrounder,
  ) {
    this.geminiClient = config.geminiApiKey
      ? new GoogleGenAI({ apiKey: config.geminiApiKey })
      : undefined;
    this.newsGrounder =
      newsGrounder ?? new AtlusNewsGrounder(config.newsFeedCacheTtlMs, logger);
  }

  private getActiveGeminiModelChain(): string[] {
    const chain = buildGeminiModelChain(
      this.config.geminiModel,
      this.config.geminiFallbackModels,
    );
    const nowMs = Date.now();
    const healthy = chain.filter((m) => (this.modelCooldownUntilMs.get(m) ?? 0) <= nowMs);
    return healthy.length > 0 ? healthy : chain;
  }

  private markModelTemporaryFailure(model: string, err: unknown): void {
    if (shouldTryNextModel(err)) {
      this.modelCooldownUntilMs.set(model, Date.now() + MODEL_FAILURE_COOLDOWN_MS);
    }
  }

  /**
   * Retries the same model up to 2 extra times with short backoff when Google returns
   * a transient 503 ("Spikes in demand are usually temporary") before failing over.
   */
  private async runWith503Retry<T>(model: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TRANSIENT_503_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        const info = getErrorInfo(err);
        const retryDelayMs = TRANSIENT_503_RETRY_DELAYS_MS[attempt];
        if (info.status === 503 && retryDelayMs !== undefined) {
          this.logger.warn(
            { model, attempt: attempt + 1, retryDelayMs },
            'Transient 503 on Gemini model; retrying same model after short delay.',
          );
          await sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async generateReply(request: BrainRequest): Promise<BrainResponse> {
    const mode = classifyBrainMode(request.promptText, request.quotedText);
    const preferredLang = inferPreferredReplyLanguage(request.promptText);
    const timeContext = resolveTimeContext(request.now);
    const systemInstruction = buildSystemInstruction(mode, timeContext, preferredLang);

    if (!this.geminiClient && !this.config.groqApiKey) {
      return {
        mode,
        provider: 'fallback',
        groundingUrls: [],
        formattedText:
          preferredLang === 'id'
            ? 'Modul kognitif saya belum terhubung ke GEMINI_API_KEY di .env. Mohon periksa konfigurasi terlebih dahulu.'
            : 'My cognitive module is currently missing GEMINI_API_KEY in .env. Please verify configuration.',
      };
    }

    if (mode === 'casual') {
      return this.runCasualMode(request, systemInstruction, preferredLang);
    }

    return this.runSeriousMode(request, systemInstruction, preferredLang);
  }

  private async runCasualMode(
    request: BrainRequest,
    systemInstruction: string,
    preferredLang: 'en' | 'id',
  ): Promise<BrainResponse> {
    const userPrompt = buildUserTurnPrompt(request, 'casual');
    const modelChain = this.getActiveGeminiModelChain();

    if (this.geminiClient) {
      for (const model of modelChain) {
        try {
          const result = await this.runWith503Retry(model, () =>
            this.geminiClient!.models.generateContent({
              model,
              contents: userPrompt,
              config: {
                abortSignal: AbortSignal.timeout(this.config.geminiTimeoutMs),
                systemInstruction,
                maxOutputTokens: 1024,
                responseMimeType: 'application/json',
                responseSchema: CASUAL_RESPONSE_SCHEMA,
                thinkingConfig: buildThinkingConfig(model),
              },
            }),
          );

          const rawText = result.text?.trim() ?? '';
          const structured = parseStructuredBrainPayload(rawText);
          if (structured) {
            return {
              mode: 'casual',
              provider: 'gemini',
              modelUsed: model,
              groundingUrls: [],
              formattedText: formatStructuredPayload(structured),
            };
          }

          if (rawText) {
            return {
              mode: 'casual',
              provider: 'gemini',
              modelUsed: model,
              groundingUrls: [],
              formattedText: rawText,
            };
          }
        } catch (err) {
          this.markModelTemporaryFailure(model, err);
          const info = getErrorInfo(err);
          this.logger.warn(
            { model, status: info.status, errName: info.name },
            'Gemini Mode Santai attempt failed; checking fallback.',
          );
          if (!shouldTryNextModel(err)) {
            break;
          }
        }
      }
    }

    if (this.config.groqApiKey) {
      const groqReply = await this.callGroqFallback(systemInstruction, userPrompt, true);
      if (groqReply) {
        const structured = parseStructuredBrainPayload(groqReply);
        return {
          mode: 'casual',
          provider: 'groq',
          modelUsed: this.config.groqModel,
          groundingUrls: [],
          formattedText: structured ? formatStructuredPayload(structured) : groqReply,
        };
      }
    }

    return this.buildOverloadFallback('casual', preferredLang);
  }

  private async runSeriousMode(
    request: BrainRequest,
    systemInstruction: string,
    preferredLang: 'en' | 'id',
  ): Promise<BrainResponse> {
    const searchQuery = `${request.promptText} ${request.quotedText ?? ''}`.trim();
    const liveArticles = await this.newsGrounder.getRelevantNews(searchQuery, 5);
    const userPrompt = buildUserTurnPrompt(request, 'serious', liveArticles);
    const modelChain = this.getActiveGeminiModelChain();

    if (this.geminiClient) {
      const canTrySearchGrounding =
        this.config.enableSearchGrounding && Date.now() >= this.searchGroundingCooldownUntilMs;

      if (canTrySearchGrounding) {
        const primaryModel = modelChain[0];
        if (primaryModel) {
          try {
            const grounded = await this.callGeminiSeriousText(
              primaryModel,
              systemInstruction,
              userPrompt,
              true,
              liveArticles,
            );
            if (grounded) {
              return grounded;
            }
          } catch (err) {
            const info = getErrorInfo(err);
            if (info.status === 429 || info.status === 403 || info.status === 400) {
              this.searchGroundingCooldownUntilMs = Date.now() + SEARCH_GROUNDING_COOLDOWN_MS;
            }
            this.logger.warn(
              { model: primaryModel, status: info.status, errName: info.name },
              'Gemini Search Grounding unavailable or quota-limited; falling back to RSS-backed Mode Serius.',
            );
          }
        }
      }

      // Attempt RSS-backed Mode Serius across primary + fallback Gemini models.
      for (const model of modelChain) {
        try {
          const rssBacked = await this.runWith503Retry(model, () =>
            this.callGeminiSeriousText(
              model,
              systemInstruction,
              userPrompt,
              false,
              liveArticles,
            ),
          );
          if (rssBacked) {
            return rssBacked;
          }
        } catch (err) {
          this.markModelTemporaryFailure(model, err);
          const info = getErrorInfo(err);
          this.logger.warn(
            { model, status: info.status, errName: info.name },
            'Gemini Mode Serius RSS-backed attempt failed; checking next model.',
          );
          if (!shouldTryNextModel(err)) {
            break;
          }
        }
      }
    }

    if (this.config.groqApiKey) {
      const groqReply = await this.callGroqFallback(systemInstruction, userPrompt, false);
      if (groqReply) {
        const rssUrls = liveArticles.map((a) => a.videoUrl ?? a.url);
        return {
          mode: 'serious',
          provider: 'groq',
          modelUsed: this.config.groqModel,
          groundingUrls: rssUrls,
          formattedText: appendFallbackSourcesIfMissing(groqReply, rssUrls),
        };
      }
    }

    return this.buildOverloadFallback('serious', preferredLang);
  }

  private async callGeminiSeriousText(
    model: string,
    systemInstruction: string,
    userPrompt: string,
    useGoogleSearch: boolean,
    liveArticles: readonly GroundedArticle[],
  ): Promise<BrainResponse | undefined> {
    if (!this.geminiClient) {
      return undefined;
    }

    const result = await this.geminiClient.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        abortSignal: AbortSignal.timeout(this.config.geminiTimeoutMs),
        systemInstruction,
        maxOutputTokens: 1200,
        thinkingConfig: buildThinkingConfig(model),
        ...(useGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
      },
    });

    const rawText = result.text?.trim();
    if (!rawText) {
      return undefined;
    }

    const searchUrls = extractGroundingUrls(result.candidates?.[0]);
    const cleanSearchUrls = searchUrls.filter(
      (url) => !url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect/'),
    );
    const rssUrls = liveArticles.map((article) => article.videoUrl ?? article.url);
    const verifiedUrls =
      cleanSearchUrls.length > 0 ? cleanSearchUrls : rssUrls.length > 0 ? rssUrls : searchUrls;

    return {
      mode: 'serious',
      provider: 'gemini',
      modelUsed: model,
      groundingUrls: verifiedUrls,
      formattedText: appendFallbackSourcesIfMissing(rawText, verifiedUrls),
    };
  }

  private async callGroqFallback(
    systemInstruction: string,
    userPrompt: string,
    expectJson: boolean,
  ): Promise<string | undefined> {
    if (!this.config.groqApiKey) {
      return undefined;
    }

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(this.config.geminiTimeoutMs),
        headers: {
          Authorization: `Bearer ${this.config.groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.groqModel,
          temperature: expectJson ? 0.7 : 0.35,
          max_tokens: expectJson ? 450 : 700,
          ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Groq fallback returned non-OK status.');
        return undefined;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() || undefined;
    } catch (err) {
      this.logger.warn({ err }, 'Groq fallback call failed.');
      return undefined;
    }
  }

  private buildOverloadFallback(mode: 'casual' | 'serious', preferredLang: 'en' | 'id'): BrainResponse {
    const formattedText =
      preferredLang === 'id'
        ? 'Maaf, modul pemrosesan kognitif saya sedang mengalami beban berlebih sementara. Mohon coba kembali sebentar lagi.'
        : 'Apologies, my cognitive processors are experiencing temporary overload. Please wait a moment and try again.';

    return {
      mode,
      provider: 'fallback',
      groundingUrls: [],
      formattedText,
    };
  }
}
