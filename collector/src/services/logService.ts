import config from '../config';
import logger from '../utils/logger';
import { ValidationError } from '../utils/errors';
import { normalizeEventPayload, normalizeBatchPayload } from '../utils/validators';
import {
  insertEvent,
  insertEventsBulk,
  getEvents,
  countEvents,
  type EventFilters,
  type EventPayload,
  type Pagination,
  type StoredEvent,
} from '../storage/eventRepository';
import { appendEvent, appendBatch } from '../storage/csvWriter';

type PaginationConfig = {
  maxLimit: number;
  defaultLimit: number;
};

export interface ListEventsQuery extends Record<string, unknown> {
  limit?: number | string;
  offset?: number | string;
  session_id?: string;
  user_id?: string;
  event?: string;
  from?: string;
  to?: string;
}

export interface ListEventsResult {
  items: StoredEvent[];
  total: number;
  limit: number;
  offset: number;
}

const coerceInteger = (value: unknown): number => {
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
};

const resolvePaginationConfig = (): PaginationConfig => {
  const pagination = (config as Record<string, unknown>).pagination as Partial<PaginationConfig> | undefined;
  const maxLimit = Number.isFinite(pagination?.maxLimit) ? Number(pagination?.maxLimit) : 100;
  const defaultLimit = Number.isFinite(pagination?.defaultLimit) ? Number(pagination?.defaultLimit) : Math.min(100, maxLimit);
  return { maxLimit, defaultLimit };
};

const ensurePagination = (rawLimit: unknown, rawOffset: unknown): Pagination => {
  const { maxLimit, defaultLimit } = resolvePaginationConfig();
  const limitCandidate = coerceInteger(rawLimit);
  const offsetCandidate = coerceInteger(rawOffset);
  const limit = Number.isFinite(limitCandidate)
    ? Math.min(Math.max(limitCandidate, 1), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(offsetCandidate) && offsetCandidate >= 0 ? offsetCandidate : 0;
  return { limit, offset };
};

export const ingestEvent = async (payload: unknown): Promise<StoredEvent> => {
  const event = normalizeEventPayload(payload) as EventPayload;
  const stored = await insertEvent(event);
  await appendEvent(stored);
  logger.debug('Event ingested', {
    session_id: stored.session_id,
    user_id: stored.user_id,
    delta_t: stored.delta_t,
  });
  return stored;
};

export const ingestBatch = async (payloads: readonly unknown[]): Promise<StoredEvent[]> => {
  const events = normalizeBatchPayload(payloads) as EventPayload[];
  const stored = await insertEventsBulk(events);
  await appendBatch(stored);
  logger.debug('Batch ingested', { count: stored.length });
  return stored;
};

export const listEvents = async (query: ListEventsQuery = {}): Promise<ListEventsResult> => {
  const pagination = ensurePagination(query.limit, query.offset);
  const filters: EventFilters = {};

  if (query.session_id) {
    filters.sessionId = String(query.session_id);
  }
  if (query.user_id) {
    filters.userId = String(query.user_id);
  }
  if (query.event) {
    filters.event = String(query.event);
  }
  if (query.from) {
    try {
      filters.fromTimestamp = new Date(String(query.from)).toISOString();
    } catch {
      throw new ValidationError('Invalid from timestamp');
    }
  }
  if (query.to) {
    try {
      filters.toTimestamp = new Date(String(query.to)).toISOString();
    } catch {
      throw new ValidationError('Invalid to timestamp');
    }
  }

  const [items, total] = await Promise.all([
    getEvents(filters, pagination),
    countEvents(filters),
  ]);

  return {
    items,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
};

export const logService = {
  ingestEvent,
  ingestBatch,
  listEvents,
};

export default logService;
