import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import CsvSink from '../../src/sink/csvSink';
import type { CsvRecord } from '../../src/sink/csvSink';

type CsvValues = string[];

const parseCsvLine = (line: string): CsvValues => {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        const next = line[index + 1];
        if (next === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else if (char === '"') {
      quoted = true;
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
};

describe('CsvSink', () => {
  let tmpDir: string;

  const readLines = async (filename: string): Promise<string[]> => {
    const content = await fs.readFile(path.join(tmpDir, filename), 'utf8');
    return content
      .split('\r\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-sink-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes header once and appends rows sequentially', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'daily' });

    await sink.write({
      timestamp_utc: '2024-01-01T00:00:00.000Z',
      method: 'POST',
      path: '/ingest',
    });

    await sink.write({
      timestamp_utc: '2024-01-01T01:00:00.000Z',
      method: 'POST',
      path: '/ingest/batch',
    });

    await sink.shutdown();

    const lines = await readLines('2024-01-01.csv');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('timestamp_utc,uid,session_id,method,path,referer,user_agent,ip,op_category,status_code,latency_ms');

    const firstRow = parseCsvLine(lines[1]);
    const secondRow = parseCsvLine(lines[2]);

    expect(firstRow[0]).toBe('2024-01-01T00:00:00.000Z');
    expect(firstRow[3]).toBe('POST');
    expect(firstRow[4]).toBe('/ingest');
    expect(secondRow[4]).toBe('/ingest/batch');
  });

  it('quotes fields that contain commas, quotes, or newlines', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'daily' });

    await sink.write({
      timestamp_utc: '2024-02-02T03:04:05.000Z',
      method: 'GET',
      path: '"/danger,\nline"',
      referer: 'https://example.com/list?a=1,b=2',
      user_agent: 'Agent "Zero"',
    });

    await sink.shutdown();

    const lines = await readLines('2024-02-02.csv');
    expect(lines).toHaveLength(2);

    const row = parseCsvLine(lines[1]);
    expect(row[3]).toBe('GET');
    expect(row[4]).toBe('"/danger,\nline"');
    expect(row[5]).toBe('https://example.com/list?a=1,b=2');
    expect(row[6]).toBe('Agent "Zero"');
  });

  it('rotates files daily', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'daily' });

    await sink.write({ timestamp_utc: '2024-03-01T23:59:00.000Z', method: 'GET', path: '/a' });
    await sink.write({ timestamp_utc: '2024-03-02T00:00:01.000Z', method: 'GET', path: '/b' });

    await sink.shutdown();

    const files = await fs.readdir(tmpDir);
    expect(files.sort()).toEqual(['2024-03-01.csv', '2024-03-02.csv']);
  });

  it('rotates files hourly when configured', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'hourly' });

    await sink.write({ timestamp_utc: '2024-04-05T05:10:00.000Z', method: 'GET', path: '/a' });
    await sink.write({ timestamp_utc: '2024-04-05T06:15:00.000Z', method: 'GET', path: '/b' });

    await sink.shutdown();

    const files = await fs.readdir(tmpDir);
    expect(files.sort()).toEqual(['2024-04-05-05.csv', '2024-04-05-06.csv']);
  });

  it('preserves write order even when writes are concurrent', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'daily' });

    const records: CsvRecord[] = [
      { timestamp_utc: '2024-05-01T00:00:00.000Z', path: '/first' },
      { timestamp_utc: '2024-05-01T00:00:01.000Z', path: '/second' },
      { timestamp_utc: '2024-05-01T00:00:02.000Z', path: '/third' },
    ];

    await Promise.all(records.map((record) => sink.write(record)));
    await sink.shutdown();

    const lines = await readLines('2024-05-01.csv');
    const values = lines.slice(1).map((line) => parseCsvLine(line)[4]);

    expect(values).toEqual(['/first', '/second', '/third']);
  });

  it('rejects new writes after shutdown is initiated', async () => {
    const sink = new CsvSink({ dir: tmpDir, rotation: 'daily' });

    await sink.write({ timestamp_utc: '2024-06-01T00:00:00.000Z', path: '/initial' });
    await sink.shutdown();

    await expect(
      sink.write({ timestamp_utc: '2024-06-01T00:00:01.000Z', path: '/late' })
    ).rejects.toThrow('CsvSink is shutting down');
  });
});
