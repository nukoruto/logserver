const { ValidationError } = require('./errors');

const REQUIRED_FIELDS = ['session_id', 'user_id', 'event'];
const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

const normalizeTimestamp = (value) => {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('Invalid timestamp format', { field: 'timestamp' });
  }
  const isoValue = date.toISOString();
  if (!ISO_DATE_PATTERN.test(isoValue)) {
    return isoValue;
  }
  return isoValue;
};

const normalizeString = (value, field) => {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new ValidationError(`${field} cannot be empty`, { field });
  }
  return trimmed;
};

const ensureRequired = (payload) => {
  const missing = REQUIRED_FIELDS.filter((field) => {
    if (payload[field] !== undefined && payload[field] !== null) {
      return false;
    }
    const camel = field.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
    return payload[camel] === undefined || payload[camel] === null;
  });
  if (missing.length > 0) {
    throw new ValidationError('Missing required fields', { fields: missing });
  }
};

const coerceField = (payload, key) => {
  if (payload[key] !== undefined) {
    return payload[key];
  }
  const camel = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
  return payload[camel];
};

const normalizeMetadata = (payload) => {
  const meta = coerceField(payload, 'meta');
  const metadata = coerceField(payload, 'metadata');
  const merged = meta || metadata || {};
  if (typeof merged !== 'object' || Array.isArray(merged)) {
    throw new ValidationError('Metadata must be an object', { field: 'metadata' });
  }
  return merged;
};

const normalizeEventPayload = (payload) => {
  ensureRequired(payload);

  const sessionId = normalizeString(coerceField(payload, 'session_id'), 'session_id');
  const userId = normalizeString(coerceField(payload, 'user_id'), 'user_id');
  const event = normalizeString(coerceField(payload, 'event'), 'event');
  const timestamp = normalizeTimestamp(coerceField(payload, 'timestamp'));
  const method = coerceField(payload, 'method');
  const path = coerceField(payload, 'path');
  const status = coerceField(payload, 'status');
  const latencyMs = coerceField(payload, 'latency_ms');
  const metadata = normalizeMetadata(payload);

  const result = {
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

const normalizeBatchPayload = (payload) => {
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

module.exports = {
  normalizeEventPayload,
  normalizeBatchPayload,
};
