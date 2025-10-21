import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpochSec, CsvSchemaError } from '../src/index.js';

test('parses numeric epoch seconds from string', () => {
  const value = parseEpochSec('1722528896.123');
  assert.equal(value, 1722528896.123);
});

test('parses numeric epoch seconds from number', () => {
  const value = parseEpochSec(1722528896.5);
  assert.equal(value, 1722528896.5);
});

test('parses RFC3339 timestamps with microseconds precisely', () => {
  const ts = '2024-08-01T12:34:56.123456Z';
  const value = parseEpochSec(ts);
  const expected = Date.UTC(2024, 7, 1, 12, 34, 56) / 1000 + 0.123456;
  assert.ok(Math.abs(value - expected) < 1e-9);
});

test('parses RFC3339 timestamps with nanosecond precision into double', () => {
  const ts = '2024-08-01T12:34:56.123456789+09:00';
  const value = parseEpochSec(ts);
  const expected = Date.UTC(2024, 7, 1, 3, 34, 56) / 1000 + 0.123456789;
  const diff = Math.abs(value - expected);
  assert.ok(diff < 1e-9, `diff=${diff}`);
});

test('rejects invalid calendar dates', () => {
  assert.throws(() => parseEpochSec('2024-02-30T00:00:00Z'), (error: unknown) => {
    return error instanceof CsvSchemaError && error.message === 'invalid_timestamp_value';
  });
});

test('rejects malformed timestamps', () => {
  assert.throws(() => parseEpochSec('2024/02/01 00:00:00Z'), (error: unknown) => {
    return error instanceof CsvSchemaError && error.message === 'invalid_timestamp_format';
  });
});
