import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable, PassThrough } from 'node:stream';
import { parseCsv, CsvSchemaError, CsvRow, parseEpochSec, expectedColumns } from '../src/index.js';

const HEADER = [
  'timestamp_utc',
  'uid',
  'session_id',
  'method',
  'path',
  'referer',
  'user_agent',
  'ip',
  'cookie',
  'op_category'
].join(',');

test('parses valid CSV rows with normalized timestamp and row index', async () => {
  const timestamp = '1722528896.789';
  const csv = `${HEADER}\n${timestamp},user-1,sess-1,GET,/index.html,https://example.com,UA,127.0.0.1,cookie-1,READ\n`;
  const parser = parseCsv(Readable.from([csv]));

  const collected: CsvRow[] = [];
  for await (const row of parser) {
    collected.push(row);
  }

  assert.equal(collected.length, 1);
  assert.equal(collected[0].timestamp_utc, Number(timestamp));
  assert.equal(collected[0].timestamp_epoch_seconds, parseEpochSec(Number(timestamp)));
  assert.equal(collected[0].row_index, 0);
  assert.equal(collected[0].uid, 'user-1');
  assert.equal(collected[0].cookie, 'cookie-1');

  const stats = parser.getStats();
  assert.equal(stats.validRows, 1);
  assert.equal(stats.invalidRows, 0);
  assert.equal(stats.totalRows, 1);
  assert.equal(stats.schemaValidated, true);
});

test('row_index preserves ingestion order even when invalid rows are skipped', async () => {
  const timestamp = '1722528896.0';
  const lines = [
    HEADER,
    `${timestamp},user-a,sess-1,GET,/alpha,https://ref,UA,127.0.0.1,c-1,READ`,
    `invalid-timestamp,user-a,sess-1,GET,/beta,https://ref,UA,127.0.0.1,c-2,READ`,
    `${timestamp},user-a,sess-1,POST,/gamma,https://ref,UA,127.0.0.1,c-3,UPDATE`
  ];
  const invalid: { reason: string; rowIndex: number }[] = [];
  const parser = parseCsv(Readable.from([`${lines.join('\n')}\n`]), {
    onInvalidRow: ({ reason, rowIndex }) => invalid.push({ reason, rowIndex })
  });

  const collected: CsvRow[] = [];
  for await (const row of parser) {
    collected.push(row);
  }

  assert.equal(collected.length, 2);
  assert.deepEqual(
    collected.map((row) => row.row_index),
    [0, 2]
  );
  assert.deepEqual(invalid, [{ reason: 'invalid_timestamp_value', rowIndex: 1 }]);

  const stats = parser.getStats();
  assert.equal(stats.totalRows, 3);
  assert.equal(stats.validRows, 2);
  assert.equal(stats.invalidRows, 1);
  assert.equal(stats.invalidReasons['invalid_timestamp_value'], 1);
});

test('counts non-numeric timestamps and skips the row', async () => {
  const timestamp = '2024/08/01 12:34:56';
  const csv = `${HEADER}\n${timestamp},user-2,sess-2,POST,/api,-,UA,127.0.0.2,c-2,UPDATE\n`;
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
  assert.equal(stats.invalidReasons['invalid_timestamp_value'], 1);
  assert.deepEqual(invalid, [{ reason: 'invalid_timestamp_value', rowIndex: 0 }]);
});

test('rejects rows violating schema constraints', async () => {
  const csv = `${HEADER}\n1722528896.0,,sess-2,POST,/api,-,UA,127.0.0.2,,WRITE\n`;
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

test('rejects rows with missing cookie values', async () => {
  const csv = `${HEADER}\n1722528896.0,user-4,sess-4,GET,/app,-,UA,127.0.0.4,,READ\n`;
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
  assert.equal(stats.invalidReasons['missing_value:cookie'], 1);
  assert.deepEqual(invalid, [{ reason: 'missing_value:cookie' }]);
});

test('throws when required columns are missing in header', async () => {
  const header = 'timestamp_utc,uid,session_id,method,path';
  const csv = `${header}\n1722528896.0,user,sess,GET,/\n`;
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
    const timestamp = ((base + i) / 1000).toFixed(6);
    const line = `${timestamp},user-${i % 10},sess-${Math.floor(i / 10)},GET,/resource${i},-,UA,192.0.2.${i % 255},cookie-${i},READ\n`;
    stream.write(line);
  }
  stream.end();

  await consume;

  assert.equal(count, rows);
  assert.ok(lastRow);
  assert.equal(lastRow?.row_index, rows - 1);
  assert.equal(parser.getStats().totalRows, rows);
});

test('schema required columns remain aligned with contract definition', async () => {
  const schemaPath = new URL('../../../schemas/log_schema_v2.yaml', import.meta.url);
  const content = await fs.readFile(schemaPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const required: string[] = [];
  let capture = false;
  for (const line of lines) {
    if (!capture) {
      if (line.trim().startsWith('required_columns:')) {
        capture = true;
      }
      continue;
    }
    if (!line.startsWith('  -')) {
      break;
    }
    const value = line
      .slice(3)
      .split('#')[0]
      .trim();
    if (value.length > 0) {
      required.push(value);
    }
  }
  assert.deepEqual(required, HEADER.split(','));
  assert.deepEqual(required, [...expectedColumns]);
});
