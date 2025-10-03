const { ensureDatabase, run, all, get } = require('./database');
const logger = require('../utils/logger');

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
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)');
  logger.info('Event table ensured');
};

const serializeMetadata = (metadata) => JSON.stringify(metadata || {});

const deserializeMetadata = (value) => {
  try {
    return value ? JSON.parse(value) : {};
  } catch (error) {
    return { raw: value };
  }
};

const insertEvent = async (event) => {
  const sql = `
    INSERT INTO events (timestamp, session_id, user_id, event, method, path, status, latency_ms, metadata, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  ];
  const result = await run(sql, params);
  return {
    id: result.lastID,
    ...event,
    received_at: receivedAt,
  };
};

const insertEventsBulk = async (events) => {
  await run('BEGIN TRANSACTION');
  const inserted = [];
  try {
    // sequential insertion keeps implementation simple and reliable for SQLite WAL mode
    for (const event of events) {
      // eslint-disable-next-line no-await-in-loop
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
