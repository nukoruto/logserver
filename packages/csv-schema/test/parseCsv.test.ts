import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { parseCsv, CsvSchemaError, CsvRow, parseEpochSec } from '../src/index.js';

const HEADER = [
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'referer',
  'user_agent',
  'ip',
  'op_category'
].join(',');

test('parses valid CSV rows with normalized timestamp and row index', async () => {
  const timestamp = '2024-08-01T12:34:56.789Z';
  const csv = `${HEADER}\n${timestamp},user-1,sess-1,GET,/index.html,https://example.com,UA,127.0.0.1,READ\n`;
  const parser = parseCsv(Readable.from([csv]));

  const collected: CsvRow[] = [];
  for await (const row of parser) {
    collected.push(row);
  }

  assert.equal(collected.length, 1);
  assert.equal(collected[0].timestamp_utc, timestamp);
  assert.equal(
    collected[0].timestamp_epoch_seconds,
    parseEpochSec(timestamp)
  );
  assert.equal(collected[0].row_index, 0);
  assert.equal(collected[0].uid, 'user-1');

  const stats = parser.getStats();
  assert.equal(stats.validRows, 1);
  assert.equal(stats.invalidRows, 0);
  assert.equal(stats.totalRows, 1);
  assert.equal(stats.schemaValidated, true);
});

test('counts invalid RFC3339 timestamps and skips the row', async () => {
  const timestamp = '2024/08/01 12:34:56';
  const csv = `${HEADER}\n${timestamp},user-2,sess-2,POST,/api,-,UA,127.0.0.2,UPDATE\n`;
  const invalid: { reason: string; rowIndex: number }[] = [];
  const parser = parseCsv(Readable.from([csv]), {
    onInvalidRow: ({ reason, rowIndex }) => invalid.push({ reason, rowIndex })
  });

  let emitted = 0;
  for await (const _row of parser) {
    emitted += 1;
  }

  assert.equal(emitted, 0);
  const stats = parser.getStats();
  assert.equal(stats.validRows, 0);
  assert.equal(stats.invalidRows, 1);
  assert.equal(stats.totalRows, 1);
  assert.equal(stats.invalidReasons['invalid_timestamp_format'], 1);
  assert.deepEqual(invalid, [{ reason: 'invalid_timestamp_format', rowIndex: 0 }]);
});

test('rejects rows violating schema constraints', async () => {
  const csv = `${HEADER}\n2024-08-01T12:34:56Z,,sess-2,POST,/api,-,UA,127.0.0.2,WRITE\n`;
  const invalid: { reason: string }[] = [];
  const parser = parseCsv(Readable.from([csv]), {
    onInvalidRow: ({ reason }) => invalid.push({ reason })
  });

  for await (const _ of parser) {
    // consume
  }

  const stats = parser.getStats();
  assert.equal(stats.validRows, 0);
  assert.equal(stats.invalidRows, 1);
  assert.equal(stats.invalidReasons['missing_value:uid'], 1);
  assert.deepEqual(invalid, [{ reason: 'missing_value:uid' }]);
});

test('throws when required columns are missing in header', async () => {
  const header = 'timestamp_utc,uid,session_id,method,path';
  const csv = `${header}\n2024-08-01T12:34:56.000Z,user,sess,GET,/\n`;
  const parser = parseCsv(Readable.from([csv]));

  await assert.rejects(async () => {
    for await (const _row of parser) {
      // consume
    }
  }, (error: unknown) => error instanceof CsvSchemaError && /Missing required columns/.test(error.message));
});

test('streams large files without buffering all rows in memory', async () => {
  const rows = 25000;
  const stream = new PassThrough();
  const parser = parseCsv(stream);
  let count = 0;
  let lastRow: CsvRow | undefined;
  const consume = (async () => {
    for await (const row of parser) {
      count += 1;
      lastRow = row;
    }
  })();

  stream.write(`${HEADER}\n`);
  const base = Date.parse('2024-01-01T00:00:00.000Z');
  for (let i = 0; i < rows; i += 1) {
    const timestamp = new Date(base + i).toISOString();
    const line = `${timestamp},user-${i % 10},sess-${Math.floor(i / 10)},GET,/resource${i},-,UA,192.0.2.${i % 255},READ\n`;
    stream.write(line);
  }
  stream.end();

  await consume;

  assert.equal(count, rows);
  assert.ok(lastRow);
  assert.equal(lastRow?.row_index, rows - 1);
  assert.equal(parser.getStats().totalRows, rows);
});
