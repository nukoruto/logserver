import { expect, test } from 'vitest';

import { hourOfUTC } from '../src/index.js';

test('hourOfUTC extracts UTC hour for integer timestamps', () => {
  expect(hourOfUTC(1720000000)).toBe(9);
  expect(hourOfUTC(1720003600)).toBe(10);
});

test('hourOfUTC truncates fractional seconds before conversion', () => {
  expect(hourOfUTC(1720000000.999)).toBe(9);
  expect(hourOfUTC(1720003600.001)).toBe(10);
});

test('hourOfUTC throws for non-finite inputs', () => {
  expect(() => hourOfUTC(Number.NaN)).toThrow(TypeError);
  expect(() => hourOfUTC(Number.POSITIVE_INFINITY)).toThrow(TypeError);
});

test('hourOfUTC rejects timestamps that overflow Date range', () => {
  expect(() => hourOfUTC(1e20)).toThrow(RangeError);
});
