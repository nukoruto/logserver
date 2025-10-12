import * as crypto from 'node:crypto';

const HEX_PATTERN = /^[0-9a-fA-F]+$/u;

const HKDF_SALT = Buffer.alloc(0);
const SID_INFO = Buffer.from('sid', 'utf8');
const HKDF_OUTPUT_LENGTH = 32;

const isProbablyHex = (value: string): boolean => HEX_PATTERN.test(value) && value.length % 2 === 0;

const decodeBase64 = (value: string): Buffer => {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0) {
      throw new Error('Base64 key decoded to empty buffer');
    }
    const normalisedInput = value.replace(/=+$/u, '');
    const reencoded = decoded.toString('base64').replace(/=+$/u, '');
    if (normalisedInput !== reencoded) {
      throw new Error('Base64 key contained invalid characters');
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid base64 key: ${error.message}`);
    }
    throw new Error('Invalid base64 key');
  }
};

export const parseKey = (raw: unknown): Buffer => {
  if (typeof raw !== 'string') {
    throw new Error('JWT_HMAC_KEY must be provided as a string');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('JWT_HMAC_KEY cannot be empty');
  }

  if (isProbablyHex(trimmed)) {
    const buffer = Buffer.from(trimmed, 'hex');
    if (buffer.length === 0) {
      throw new Error('Hex key decoded to empty buffer');
    }
    return buffer;
  }

  return decodeBase64(trimmed);
};

export const deriveDatasetKey = (rawKey: unknown): Buffer => {
  const ikm = parseKey(rawKey);
  const derived = crypto.hkdfSync('sha256', ikm, HKDF_SALT, SID_INFO, HKDF_OUTPUT_LENGTH);
  return Buffer.from(derived);
};

export const jwtToUid = (jwt: unknown, key: unknown): string => {
  if (typeof jwt !== 'string') {
    throw new Error('JWT must be provided as a string');
  }
  const trimmedJwt = jwt.trim();
  if (!trimmedJwt) {
    throw new Error('JWT cannot be empty');
  }
  const datasetKey = deriveDatasetKey(key);
  return crypto.createHmac('sha256', datasetKey).update(trimmedJwt, 'utf8').digest('hex');
};
