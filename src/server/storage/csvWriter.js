const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

const headerRow = 'timestamp,session_id,user_id,event,method,path,status,latency_ms,metadata';
const headerCache = new Set();

const ensureHeader = async (filePath) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (headerCache.has(filePath)) {
    return;
  }

  let exists = true;
  try {
    await fs.access(filePath);
  } catch (error) {
    exists = false;
  }

  if (!exists) {
    await fs.writeFile(filePath, `${headerRow}\n`, { encoding: 'utf8' });
  } else {
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      await fs.appendFile(filePath, `${headerRow}\n`, { encoding: 'utf8' });
    }
  }

  headerCache.add(filePath);
};

const toCsvField = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? value.toString() : JSON.stringify(value);
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
};

const appendEvent = async (event) => {
  const datePrefix = event.timestamp.slice(0, 10);
  const filePath = path.resolve(config.csvRoot, `events-${datePrefix}.csv`);
  await ensureHeader(filePath);
  const row = [
    event.timestamp,
    event.session_id,
    event.user_id,
    event.event,
    event.method,
    event.path,
    event.status,
    event.latency_ms,
    event.metadata || {},
  ]
    .map(toCsvField)
    .join(',');
  await fs.appendFile(filePath, `${row}\n`, { encoding: 'utf8' });
};

const appendBatch = async (events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }
  // write events grouped by day to minimise file handles
  const groups = events.reduce((acc, event) => {
    const datePrefix = event.timestamp.slice(0, 10);
    if (!acc[datePrefix]) {
      acc[datePrefix] = [];
    }
    acc[datePrefix].push(event);
    return acc;
  }, {});

  await Promise.all(
    Object.entries(groups).map(async ([datePrefix, group]) => {
      const filePath = path.resolve(config.csvRoot, `events-${datePrefix}.csv`);
      await ensureHeader(filePath);
      const content = group
        .map((event) =>
          [
            event.timestamp,
            event.session_id,
            event.user_id,
            event.event,
            event.method,
            event.path,
            event.status,
            event.latency_ms,
            event.metadata || {},
          ]
            .map(toCsvField)
            .join(',')
        )
        .join('\n');
      await fs.appendFile(filePath, `${content}\n`, { encoding: 'utf8' });
    })
  );
};

module.exports = {
  appendEvent,
  appendBatch,
};
