const { ensureDatabase, run, all, get } = require('./database');
const logger = require('../utils/logger');

const ensureColumn = async (column, type) => {
  const info = await all('PRAGMA table_info(events)');
  const exists = info.some((entry) => entry.name === column);
  if (!exists) {
    await run(`ALTER TABLE events ADD COLUMN ${column} ${type}`);
    logger.info(`Added column ${column} to events table`);
  }
};

const createSchema = async () => {
  await ensureDatabase();
  await run(`
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
  `);
  await ensureColumn('delta_t', 'REAL');
  await run('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
  logger.info('Event table ensured');
};

const serializeMetadata = (metadata) => JSON.stringify(metadata || {});

const deserializeMetadata = (value) => {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { raw: value };
  }
};

const fetchPreviousTimestamp = async (sessionId) => {
  const row = await get(
    `SELECT timestamp FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [sessionId]
  );
  if (!row) {
    return null;
  }
  return new Date(row.timestamp);
};

const computeDeltaT = async (sessionId, timestamp) => {
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

const insertEvent = async (event) => {
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
    id: result.lastID,
    ...event,
    received_at: receivedAt,
    delta_t: deltaT,
  };
};

const insertEventsBulk = async (events) => {
  await run('BEGIN TRANSACTION');
  const inserted = [];
  try {
    for (const event of events) {
      const created = await insertEvent(event);
      inserted.push(created);
    }
    await run('COMMIT');
    return inserted;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
};

const buildFilters = (filters = {}) => {
  const conditions = [];
  const params = [];

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

const mapRow = (row) => ({
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
  delta_t: row.delta_t,
});

const getEvents = async (filters = {}, pagination = {}) => {
  const { whereClause, params } = buildFilters(filters);
  const limit = pagination.limit ?? 100;
  const offset = pagination.offset ?? 0;
  const sql = `
    SELECT * FROM events
    ${whereClause}
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `;
  const rows = await all(sql, [...params, limit, offset]);
  return rows.map(mapRow);
};

const countEvents = async (filters = {}) => {
  const { whereClause, params } = buildFilters(filters);
  const sql = `SELECT COUNT(*) as total FROM events ${whereClause}`;
  const row = await get(sql, params);
  return row ? row.total : 0;
};

module.exports = {
  createSchema,
  insertEvent,
  insertEventsBulk,
  getEvents,
  countEvents,
};
