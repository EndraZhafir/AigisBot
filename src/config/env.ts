import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly logLevel: string;
  readonly waAuthDir: string;
  readonly waPairingPhone: string | undefined;
  readonly allowedGroupJids: ReadonlySet<string>;
  readonly botOwnerNumbers: ReadonlySet<string>;
  readonly dbPath: string;
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
    dbPath: env.DB_PATH?.trim() || 'data/aigis.db',
    userCooldownMs: parsePositiveInt(env.USER_COOLDOWN_MS, 15_000),
    groupCooldownMs: parsePositiveInt(env.GROUP_COOLDOWN_MS, 5_000),
  };
}
