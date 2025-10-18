import { describe, expect, it } from 'vitest';
import { algoVersion, deriveDatasetKey, makeSid, SessionSplitterError } from '../dist/index.js';

const SAMPLE_JWT_KEY = '00112233445566778899aabbccddeeff';
const EXPECTED_DATASET_KEY_HEX = 'd39c19063489d4793742e54f0d2d73e864b0772aab867dd2aa3ef5fdef61597e';
const EXPECTED_SESSION_ID = 'c28f82bff1d9ca296f31a284cb3caee56f8548b6bf68111891a6e5fe980bcba8';

describe('deriveDatasetKey', () => {
  it('derives a deterministic 32-byte key from the JWT secret', () => {
    const datasetKey = deriveDatasetKey(SAMPLE_JWT_KEY);
    expect(Buffer.isBuffer(datasetKey)).toBe(true);
    expect(datasetKey.byteLength).toBe(32);
    expect(datasetKey.toString('hex')).toBe(EXPECTED_DATASET_KEY_HEX);
  });

  it('throws when the JWT secret is blank', () => {
    expect(() => deriveDatasetKey('   ')).toThrow(SessionSplitterError);
  });
});

describe('makeSid', () => {
  it('produces a deterministic HMAC-SHA256 session identifier', () => {
    const datasetKey = deriveDatasetKey(SAMPLE_JWT_KEY);
    const sid = makeSid('user-001', 1710000123, algoVersion, datasetKey);
    expect(sid).toBe(EXPECTED_SESSION_ID);
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid inputs', () => {
    const datasetKey = deriveDatasetKey(SAMPLE_JWT_KEY);
    expect(() => makeSid('', 0, algoVersion, datasetKey)).toThrow(SessionSplitterError);
    expect(() => makeSid('user-001', Number.NaN, algoVersion, datasetKey)).toThrow(SessionSplitterError);
    expect(() => makeSid('user-001', 0, '', datasetKey)).toThrow(SessionSplitterError);
    expect(() => makeSid('user-001', 0, algoVersion, Buffer.alloc(0))).toThrow(SessionSplitterError);
  });
});
