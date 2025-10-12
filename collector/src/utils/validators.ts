import config from '../config';
import { jwtToUid } from '../security/uid';
import { ValidationError } from './errors';

const REQUIRED_FIELDS = ['session_id', 'event'] as const;
const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u;

type Payload = Record<string, unknown>;

type NormalizedEventPayload = {
  timestamp: string;
  session_id: string;
  user_id: string;
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  metadata: Record<string, unknown>;
};

const coerceField = (payload: Payload, key: string): unknown => {
  if (key in payload) {
    return payload[key];
  }
  const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return payload[camel];
};

const normalizeTimestamp = (value: unknown): string => {
  if (value === undefined || value === null || value === '') {
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

const ensureRequired = (payload: Payload): void => {
  const missing = REQUIRED_FIELDS.filter((field) => {
    if (payload[field] !== undefined && payload[field] !== null) {
      return false;
    }
    const camel = field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return payload[camel] === undefined || payload[camel] === null;
  });
  if (missing.length > 0) {
    throw new ValidationError('Missing required fields', { fields: missing });
  }
};

const resolveJwt = (payload: Payload): string | null => {
  const jwt = coerceField(payload, 'jwt');
  if (jwt === undefined || jwt === null) {
    return null;
  }
  const normalized = String(jwt).trim();
  if (!normalized) {
    throw new ValidationError('jwt cannot be empty', { field: 'jwt' });
  }
  if (!config.security.jwtHmacKey) {
    throw new ValidationError('JWT_HMAC_KEY is not configured', { field: 'jwt' });
  }
  try {
    return jwtToUid(normalized, config.security.jwtHmacKey);
  } catch (error) {
    throw new ValidationError('Failed to derive uid from jwt', {
      field: 'jwt',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
};

const resolveUserId = (payload: Payload): string => {
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

const normalizeMetadata = (payload: Payload): Record<string, unknown> => {
  const meta = coerceField(payload, 'meta');
  const metadata = coerceField(payload, 'metadata');
  const merged = (meta ?? metadata ?? {}) as unknown;
  if (typeof merged !== 'object' || merged === null || Array.isArray(merged)) {
    throw new ValidationError('Metadata must be an object', { field: 'metadata' });
  }
  return merged as Record<string, unknown>;
};

export const normalizeEventPayload = (payload: Payload): NormalizedEventPayload => {
  ensureRequired(payload);

  const sessionId = normalizeString(coerceField(payload, 'session_id'), 'session_id');
  const userId = resolveUserId(payload);
  const event = normalizeString(coerceField(payload, 'event'), 'event');
  const timestamp = normalizeTimestamp(coerceField(payload, 'timestamp'));
  const method = coerceField(payload, 'method');
  const path = coerceField(payload, 'path');
  const status = coerceField(payload, 'status');
  const latencyMs = coerceField(payload, 'latency_ms');
  const metadata = normalizeMetadata(payload);

  const normalizedStatus = Number.isFinite(Number(status)) ? Number(status) : null;
  const normalizedLatency = Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null;

  const result: NormalizedEventPayload = {
    timestamp,
    session_id: sessionId,
    user_id: userId,
    event,
    method: method ? String(method).toUpperCase() : null,
    path: path ? String(path) : null,
    status: normalizedStatus,
    latency_ms: normalizedLatency,
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
      return normalizeEventPayload(entry as Payload);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(error.message, { index, details: error.details });
      }
      throw error;
    }
  });
};

export type { NormalizedEventPayload };
