import crypto from 'node:crypto';

const BEARER_PREFIX = /^Bearer\s+/i;

export interface JwtUidOptions {
  secretHex: string;
  now?: number;
  requiredAudience?: string | string[];
}

const toBase64Url = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const decodeBase64UrlJson = (input: string): Record<string, unknown> => {
  const buffer = Buffer.from(input, 'base64url');
  const decoded = buffer.toString('utf8');
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
};

const normalizeAudience = (audience: unknown): string[] => {
  if (typeof audience === 'string') {
    return [audience];
  }
  if (Array.isArray(audience)) {
    return audience.filter((value): value is string => typeof value === 'string');
  }
  return [];
};

const ensureAudience = (
  payload: Record<string, unknown>,
  required: string | string[] | undefined,
): boolean => {
  if (!required) {
    return true;
  }
  const targets = Array.isArray(required) ? required : [required];
  if (targets.length === 0) {
    return true;
  }
  const candidate = normalizeAudience(payload.aud);
  if (candidate.length === 0) {
    return false;
  }
  return targets.every((target) => candidate.includes(target));
};

const parseSecretHex = (secretHex: string): Buffer => {
  if (typeof secretHex !== 'string' || secretHex.trim().length === 0) {
    throw new Error('secretHex must be a non-empty hex string');
  }
  const normalized = secretHex.trim();
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('secretHex must contain an even number of hexadecimal characters');
  }
  const buffer = Buffer.from(normalized, 'hex');
  if (buffer.length < 16) {
    throw new Error('secretHex must be at least 128 bits');
  }
  return buffer;
};

export const deriveUidFromAuthorization = (
  authorizationHeader: unknown,
  options: JwtUidOptions,
): string | null => {
  if (typeof authorizationHeader !== 'string' || authorizationHeader.trim().length === 0) {
    return null;
  }
  const trimmed = authorizationHeader.trim();
  if (!BEARER_PREFIX.test(trimmed)) {
    return null;
  }
  const token = trimmed.replace(BEARER_PREFIX, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeBase64UrlJson(parts[0]);
    payload = decodeBase64UrlJson(parts[1]);
  } catch {
    return null;
  }

  const secret = parseSecretHex(options.secretHex);
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signingInput, 'utf8').digest('base64url');
  if (expectedSignature !== parts[2]) {
    return null;
  }

  const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) {
    return null;
  }
  const nbf = payload.nbf;
  if (typeof nbf === 'number' && Number.isFinite(nbf) && nbf > nowSeconds) {
    return null;
  }
  if (!ensureAudience(payload, options.requiredAudience)) {
    return null;
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const uid = crypto.createHmac('sha256', secret).update(token, 'utf8').digest('hex');
  return kid ? `${uid}:${kid}` : uid;
};

export const mintTestToken = (
  payload: Record<string, unknown>,
  secretHex: string,
  headerOverrides: Record<string, unknown> = {},
): string => {
  const secret = parseSecretHex(secretHex);
  const header = { alg: 'HS256', typ: 'JWT', ...headerOverrides } as Record<string, unknown>;
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`, 'utf8')
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
};

export type { JwtUidOptions as JwtUidDerivationOptions };

