import { ensureDatabase, run, all, get } from './database';
import logger from '../utils/logger';

export interface EventPayload {
  timestamp: string;
  session_id: string;
  user_id: string;
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  metadata: Record<string, unknown>;
}

export interface StoredEvent extends EventPayload {
  id: number;
  received_at: string;
  delta_t: number;
}

export interface EventFilters {
  sessionId?: string;
  userId?: string;
  event?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
}

export interface Pagination {
  limit: number;
  offset: number;
}

interface EventRow {
  id: number;
  timestamp: string;
  session_id: string;
  user_id: string;
  event: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  metadata: string | null;
  received_at: string;
  delta_t: number | null;
}

const ensureColumn = async (column: string, type: string): Promise<void> => {
  const info = await all<{ name: string }>('PRAGMA table_info(events)');
  const exists = info.some((entry) => entry.name === column);
  if (!exists) {
    await run(`ALTER TABLE events ADD COLUMN ${column} ${type}`);
    logger.info(`Added column ${column} to events table`);
  }
};

export const createSchema = async (): Promise<void> => {
  await ensureDatabase();
  await run(
    `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      method TEXT,
      path TEXT,
      status INTEGER,
      latency_ms INTEGER,
      metadata TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      delta_t REAL
    )
  `
  );
  await ensureColumn('delta_t', 'REAL');
  await run('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
  logger.info('Event table ensured');
};

const serializeMetadata = (metadata: Record<string, unknown>): string => JSON.stringify(metadata || {});

const deserializeMetadata = (value: string | null): Record<string, unknown> => {
  try {
    return value ? (JSON.parse(value) as Record<string, unknown>) : {};
  } catch {
    return { raw: value };
  }
};

const fetchPreviousTimestamp = async (sessionId: string): Promise<Date | null> => {
  const row = await get<{ timestamp: string }>(
    `SELECT timestamp FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [sessionId]
  );
  if (!row) {
    return null;
  }
  return new Date(row.timestamp);
};

const computeDeltaT = async (sessionId: string, timestamp: string): Promise<number> => {
  const previous = await fetchPreviousTimestamp(sessionId);
  if (!previous) {
    return 0;
  }
  const current = new Date(timestamp);
  const deltaSeconds = (current.getTime() - previous.getTime()) / 1000;
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    return 0;
  }
  return deltaSeconds;
};

export const insertEvent = async (event: EventPayload): Promise<StoredEvent> => {
  const deltaT = await computeDeltaT(event.session_id, event.timestamp);
  const sql = `
    INSERT INTO events (timestamp, session_id, user_id, event, method, path, status, latency_ms, metadata, received_at, delta_t)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const receivedAt = new Date().toISOString();
  const params = [
    event.timestamp,
    event.session_id,
    event.user_id,
    event.event,
    event.method,
    event.path,
    event.status,
    event.latency_ms,
    serializeMetadata(event.metadata),
    receivedAt,
    deltaT,
  ];
  const result = await run(sql, params);
  return {
    id: result.lastID ?? 0,
    ...event,
    received_at: receivedAt,
    delta_t: deltaT,
  };
};

export const insertEventsBulk = async (events: readonly EventPayload[]): Promise<StoredEvent[]> => {
  await run('BEGIN TRANSACTION');
  const inserted: StoredEvent[] = [];
  try {
    for (const event of events) {
      const created = await insertEvent(event);
      inserted.push(created);
    }
    await run('COMMIT');
    return inserted;
  } catch (error) {
    await run('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

const buildFilters = (filters: EventFilters = {}): { whereClause: string; params: unknown[] } => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.userId) {
    conditions.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.event) {
    conditions.push('event = ?');
    params.push(filters.event);
  }
  if (filters.fromTimestamp) {
    conditions.push('timestamp >= ?');
    params.push(filters.fromTimestamp);
  }
  if (filters.toTimestamp) {
    conditions.push('timestamp <= ?');
    params.push(filters.toTimestamp);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
};

const mapRow = (row: EventRow): StoredEvent => ({
  id: row.id,
  timestamp: row.timestamp,
  session_id: row.session_id,
  user_id: row.user_id,
  event: row.event,
  method: row.method,
  path: row.path,
  status: row.status,
  latency_ms: row.latency_ms,
  metadata: deserializeMetadata(row.metadata),
  received_at: row.received_at,
  delta_t: row.delta_t ?? 0,
});

export const getEvents = async (filters: EventFilters = {}, pagination: Partial<Pagination> = {}): Promise<StoredEvent[]> => {
  const { whereClause, params } = buildFilters(filters);
  const limit = pagination.limit ?? 100;
  const offset = pagination.offset ?? 0;
  const sql = `
    SELECT * FROM events
    ${whereClause}
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `;
  const rows = await all<EventRow>(sql, [...params, limit, offset]);
  return rows.map(mapRow);
};

export const countEvents = async (filters: EventFilters = {}): Promise<number> => {
  const { whereClause, params } = buildFilters(filters);
  const sql = `SELECT COUNT(*) as total FROM events ${whereClause}`;
  const row = await get<{ total: number }>(sql, params);
  return row ? row.total : 0;
};

export const eventRepository = {
  createSchema,
  insertEvent,
  insertEventsBulk,
  getEvents,
  countEvents,
};

export default eventRepository;
