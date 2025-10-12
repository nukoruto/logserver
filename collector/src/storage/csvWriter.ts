import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import config from '../config';
import type { StoredEvent } from './eventRepository';

const headerRow = 'timestamp,session_id,user_id,event,method,path,status,latency_ms,delta_t,metadata';
const headerCache = new Set<string>();

const ensureHeader = async (filePath: string): Promise<void> => {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  if (headerCache.has(filePath)) {
    return;
  }

  let exists = true;
  try {
    await fsPromises.access(filePath);
  } catch {
    exists = false;
  }

  if (!exists) {
    await fsPromises.writeFile(filePath, `${headerRow}\n`, { encoding: 'utf8' });
  } else {
    const stats = await fsPromises.stat(filePath);
    if (stats.size === 0) {
      await fsPromises.appendFile(filePath, `${headerRow}\n`, { encoding: 'utf8' });
    }
  }

  headerCache.add(filePath);
};

const toCsvField = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
      ? value.toString()
      : JSON.stringify(value);
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
};

export const appendEvent = async (event: StoredEvent): Promise<void> => {
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
    event.delta_t,
    event.metadata ?? {},
  ]
    .map(toCsvField)
    .join(',');
  await fsPromises.appendFile(filePath, `${row}\n`, { encoding: 'utf8' });
};

export const appendBatch = async (events: readonly StoredEvent[]): Promise<void> => {
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }
  const groups = events.reduce<Record<string, StoredEvent[]>>((acc, event) => {
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
            event.delta_t,
            event.metadata ?? {},
          ]
            .map(toCsvField)
            .join(',')
        )
        .join('\n');
      await fsPromises.appendFile(filePath, `${content}\n`, { encoding: 'utf8' });
    })
  );
};

const csvWriter = {
  appendEvent,
  appendBatch,
};

export { csvWriter };
export default csvWriter;
