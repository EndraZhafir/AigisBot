import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly logLevel: string;
  readonly waAuthDir: string;
  readonly waPairingPhone: string | undefined;
  readonly allowedGroupJids: ReadonlySet<string>;
  readonly botOwnerNumbers: ReadonlySet<string>;
  readonly geminiApiKey: string | undefined;
  readonly geminiModel: string;
  readonly geminiFallbackModels: readonly string[];
  readonly geminiTimeoutMs: number;
  readonly groqApiKey: string | undefined;
  readonly groqModel: string;
  readonly enableSearchGrounding: boolean;
  readonly newsFeedCacheTtlMs: number;
  readonly dbPath: string;
  readonly groupContextWindowSize: number;
  readonly groupMessageRetentionLimit: number;
  readonly communitySeedPath: string;
  readonly userCooldownMs: number;
  readonly groupCooldownMs: number;
}

/**
 * Splits a comma-separated env string into a trimmed, non-empty Set.
 */
export function parseCsvSet(rawValue: string | undefined): Set<string> {
  if (!rawValue) {
    return new Set();
  }

  const items = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return new Set(items);
}

/**
 * Normalizes a phone number string to digits-only international format (e.g. "6281234567890").
 * Returns undefined if the input contains no digits.
 */
export function normalizePhoneDigits(rawPhone: string | undefined): string | undefined {
  if (!rawPhone) {
    return undefined;
  }

  const digits = rawPhone.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) {
    return fallback;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function parseNodeEnv(rawValue: string | undefined): AppConfig['nodeEnv'] {
  if (rawValue === 'production' || rawValue === 'test') {
    return rawValue;
  }
  return 'development';
}

/**
 * Loads and normalizes runtime configuration from environment variables.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawOwners = parseCsvSet(env.BOT_OWNER_NUMBERS);
  const normalizedOwners = new Set<string>();
  for (const owner of rawOwners) {
    const digits = normalizePhoneDigits(owner);
    if (digits) {
      normalizedOwners.add(digits);
    }
  }

  return {
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    waAuthDir: env.WA_AUTH_DIR?.trim() || 'auth_info',
    waPairingPhone: normalizePhoneDigits(env.WA_PAIRING_PHONE),
    allowedGroupJids: parseCsvSet(env.ALLOWED_GROUP_JIDS),
    botOwnerNumbers: normalizedOwners,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    geminiFallbackModels: [
      ...parseCsvSet(
        env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.1-flash-lite',
      ),
    ],
    geminiTimeoutMs: parsePositiveInt(env.GEMINI_TIMEOUT_MS, 10_000),
    groqApiKey: env.GROQ_API_KEY?.trim() || undefined,
    groqModel: env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
    enableSearchGrounding: parseBoolean(env.ENABLE_SEARCH_GROUNDING, false),
    newsFeedCacheTtlMs: parsePositiveInt(env.NEWS_FEED_CACHE_TTL_MS, 15 * 60_000),
    dbPath: env.DB_PATH?.trim() || 'data/aigis.db',
    groupContextWindowSize: parsePositiveInt(env.GROUP_CONTEXT_WINDOW_SIZE, 12),
    groupMessageRetentionLimit: parsePositiveInt(env.GROUP_MESSAGE_RETENTION_LIMIT, 100),
    communitySeedPath: env.COMMUNITY_SEED_PATH?.trim() || 'data/community_seed.local.json',
    userCooldownMs: parsePositiveInt(env.USER_COOLDOWN_MS, 15_000),
    groupCooldownMs: parsePositiveInt(env.GROUP_COOLDOWN_MS, 5_000),
  };
}
