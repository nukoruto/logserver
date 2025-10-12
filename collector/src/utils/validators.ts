import config from '../config';
import { jwtToUid } from '../security/uid';
import { ValidationError } from './errors';

const REQUIRED_FIELDS = ['session_id', 'event'] as const;
const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

type UnknownRecord = Record<string, unknown>;

export interface NormalizedEventPayload {
  timestamp: string;
  session_id: string;
  user_id: string;
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  metadata: UnknownRecord;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toCamelCase = (value: string): string =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

const normalizeTimestamp = (value: unknown): string => {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('Invalid timestamp format', { field: 'timestamp' });
  }
  const isoValue = date.toISOString();
  if (!ISO_DATE_PATTERN.test(isoValue)) {
    return isoValue;
  }
  return isoValue;
};

const normalizeString = (value: unknown, field: string): string => {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new ValidationError(`${field} cannot be empty`, { field });
  }
  return trimmed;
};

const ensureRequired = (payload: UnknownRecord): void => {
  const missing = REQUIRED_FIELDS.filter((field: RequiredField) => {
    if (payload[field] !== undefined && payload[field] !== null) {
      return false;
    }
    const camel = toCamelCase(field);
    const alternative = payload[camel];
    return alternative === undefined || alternative === null;
  });
  if (missing.length > 0) {
    throw new ValidationError('Missing required fields', { fields: missing });
  }
};

const coerceField = (payload: UnknownRecord, key: string): unknown => {
  if (key in payload) {
    return payload[key];
  }
  const camel = toCamelCase(key);
  if (camel in payload) {
    return payload[camel];
  }
  return undefined;
};

const resolveJwt = (payload: UnknownRecord): string | null => {
  const jwt = coerceField(payload, 'jwt');
  if (jwt === undefined || jwt === null) {
    return null;
  }
  const normalized = String(jwt).trim();
  if (!normalized) {
    throw new ValidationError('jwt cannot be empty', { field: 'jwt' });
  }
  if (!config.security || !config.security.jwtHmacKey) {
    throw new ValidationError('JWT_HMAC_KEY is not configured', { field: 'jwt' });
  }
  try {
    return jwtToUid(normalized, config.security.jwtHmacKey);
  } catch (error) {
    throw new ValidationError('Failed to derive uid from jwt', {
      field: 'jwt',
      cause: error instanceof Error ? error.message : error,
    });
  }
};

const resolveUserId = (payload: UnknownRecord): string => {
  const userId = coerceField(payload, 'user_id');
  if (userId !== undefined && userId !== null) {
    return normalizeString(userId, 'user_id');
  }
  const derived = resolveJwt(payload);
  if (derived) {
    return derived;
  }
  throw new ValidationError('Either user_id or jwt must be provided', {
    fields: ['user_id', 'jwt'],
  });
};

const normalizeMetadata = (payload: UnknownRecord): UnknownRecord => {
  const meta = coerceField(payload, 'meta');
  const metadata = coerceField(payload, 'metadata');
  const merged = (meta as UnknownRecord | undefined) || (metadata as UnknownRecord | undefined) || {};
  if (!isRecord(merged)) {
    throw new ValidationError('Metadata must be an object', { field: 'metadata' });
  }
  return merged;
};

export const normalizeEventPayload = (input: unknown): NormalizedEventPayload => {
  if (!isRecord(input)) {
    throw new ValidationError('Event payload must be an object');
  }

  ensureRequired(input);

  const sessionId = normalizeString(coerceField(input, 'session_id'), 'session_id');
  const userId = resolveUserId(input);
  const event = normalizeString(coerceField(input, 'event'), 'event');
  const timestamp = normalizeTimestamp(coerceField(input, 'timestamp'));
  const method = coerceField(input, 'method');
  const path = coerceField(input, 'path');
  const status = coerceField(input, 'status');
  const latencyMs = coerceField(input, 'latency_ms');
  const metadata = normalizeMetadata(input);

  const result: NormalizedEventPayload = {
    timestamp,
    session_id: sessionId,
    user_id: userId,
    event,
    method: method ? String(method).toUpperCase() : null,
    path: path ? String(path) : null,
    status: Number.isFinite(Number(status)) ? Number(status) : null,
    latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
    metadata,
  };

  return result;
};

export const normalizeBatchPayload = (payload: unknown): NormalizedEventPayload[] => {
  if (!Array.isArray(payload)) {
    throw new ValidationError('Batch payload must be an array');
  }
  if (payload.length === 0) {
    throw new ValidationError('Batch payload cannot be empty');
  }
  return payload.map((entry, index) => {
    try {
      return normalizeEventPayload(entry);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(error.message, { index, details: error.details });
      }
      throw error;
    }
  });
};
