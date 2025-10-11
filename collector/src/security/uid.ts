import { createHmac } from 'node:crypto';

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

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

export function parseKey(raw: string): Buffer {
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
}

export function jwtToUid(jwt: string, key: string): string {
  if (typeof jwt !== 'string') {
    throw new Error('JWT must be provided as a string');
  }
  const trimmedJwt = jwt.trim();
  if (!trimmedJwt) {
    throw new Error('JWT cannot be empty');
  }
  const secret = parseKey(key);
  return createHmac('sha256', secret).update(trimmedJwt, 'utf8').digest('hex');
}
