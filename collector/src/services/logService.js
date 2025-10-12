const configModule = require('../config');
const config = configModule.default || configModule;
const loggerModule = require('../utils/logger');
const logger = loggerModule.default || loggerModule;
const { ValidationError } = require('../utils/errors');
const { normalizeEventPayload, normalizeBatchPayload } = require('../utils/validators');
const repository = require('../storage/eventRepository');
const csvWriter = require('../storage/csvWriter');

const ensurePagination = (rawLimit, rawOffset) => {
  const limit = Number.parseInt(rawLimit, 10);
  const offset = Number.parseInt(rawOffset, 10);
  const finalLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), config.pagination.maxLimit) : config.pagination.defaultLimit;
  const finalOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  return { limit: finalLimit, offset: finalOffset };
};

const ingestEvent = async (payload) => {
  const event = normalizeEventPayload(payload);
  const stored = await repository.insertEvent(event);
  await csvWriter.appendEvent(stored);
  logger.debug('Event ingested', { session_id: stored.session_id, user_id: stored.user_id, delta_t: stored.delta_t });
  return stored;
};

const ingestBatch = async (payloads) => {
  const events = normalizeBatchPayload(payloads);
  const stored = await repository.insertEventsBulk(events);
  await csvWriter.appendBatch(stored);
  logger.debug('Batch ingested', { count: stored.length });
  return stored;
};

const listEvents = async (query = {}) => {
  const pagination = ensurePagination(query.limit, query.offset);
  const filters = {};
  if (query.session_id) {
    filters.sessionId = query.session_id;
  }
  if (query.user_id) {
    filters.userId = query.user_id;
  }
  if (query.event) {
    filters.event = query.event;
  }
  if (query.from) {
    try {
      filters.fromTimestamp = new Date(query.from).toISOString();
    } catch {
      throw new ValidationError('Invalid from timestamp');
    }
  }
  if (query.to) {
    try {
      filters.toTimestamp = new Date(query.to).toISOString();
    } catch {
      throw new ValidationError('Invalid to timestamp');
    }
  }

  const [items, total] = await Promise.all([
    repository.getEvents(filters, pagination),
    repository.countEvents(filters),
  ]);

  return {
    items,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
};

module.exports = {
  ingestEvent,
  ingestBatch,
  listEvents,
};
