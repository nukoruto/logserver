import seedrandom from 'seedrandom';

export interface SessionSeedContext {
  seed?: string | number | null;
  sessionId?: string | null | undefined;
  uid?: string | null | undefined;
  namespace?: string | null | undefined;
}

export type CategoryPrngFactory = (category: string) => seedrandom.PRNG;

const DEFAULT_NAMESPACE = 'sim';
const DEFAULT_SESSION_ID = 'sess-unknown';
const DEFAULT_UID = 'uid-unknown';
const DEFAULT_CATEGORY = 'default';

const normalizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString(10);
  }
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return fallback;
};

const normalizeSeed = (seed: unknown): string => {
  if (seed === undefined || seed === null) {
    return 'seed-null';
  }
  if (typeof seed === 'string') {
    return `seed-str-${seed}`;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return `seed-num-${seed}`;
  }
  if (typeof seed === 'bigint') {
    return `seed-bigint-${seed.toString(10)}`;
  }
  return `seed-other-${JSON.stringify(seed)}`;
};

export const createSessionCategoryPrng = (
  context: SessionSeedContext,
): CategoryPrngFactory => {
  const namespace = normalizeIdentifier(context.namespace, DEFAULT_NAMESPACE);
  const sessionId = normalizeIdentifier(context.sessionId, DEFAULT_SESSION_ID);
  const uid = normalizeIdentifier(
    context.uid ?? context.sessionId ?? null,
    DEFAULT_UID,
  );
  const seedComponent = normalizeSeed(context.seed);
  const cache = new Map<string, seedrandom.PRNG>();

  return (categoryRaw: string): seedrandom.PRNG => {
    const category = normalizeIdentifier(categoryRaw, DEFAULT_CATEGORY);
    const cacheKey = `${namespace}|${uid}|${sessionId}|${seedComponent}|${category}`;
    let generator = cache.get(cacheKey);
    if (!generator) {
      generator = seedrandom(`sim|${cacheKey}`);
      cache.set(cacheKey, generator);
    }
    return generator;
  };
};

export default createSessionCategoryPrng;
