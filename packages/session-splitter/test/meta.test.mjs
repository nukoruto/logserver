import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { algoVersion, writeMeta } from '../dist/index.js';

function matchesType(type, value) {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'null':
      return value === null;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function validateAgainstSchema(schema, data, pointer = '#') {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(type, data))) {
    errors.push(`${pointer}: expected type ${types.join(' | ')}`);
    return errors;
  }

  if (types.includes('object')) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in data)) {
        errors.push(`${pointer}/${key}: required property missing`);
      }
    }

    const propertySchemas = schema.properties ?? {};
    const patternSchemas = schema.patternProperties ?? {};
    const additionalAllowed = schema.additionalProperties !== false;

    for (const [key, value] of Object.entries(data)) {
      let matched = false;
      if (key in propertySchemas) {
        const childErrors = validateAgainstSchema(propertySchemas[key], value, `${pointer}/${key}`);
        errors.push(...childErrors);
        matched = true;
      } else {
        for (const [pattern, patternSchema] of Object.entries(patternSchemas)) {
          const regex = new RegExp(pattern);
          if (regex.test(key)) {
            const childErrors = validateAgainstSchema(patternSchema, value, `${pointer}/${key}`);
            errors.push(...childErrors);
            matched = true;
            break;
          }
        }
      }
      if (!matched && !additionalAllowed) {
        errors.push(`${pointer}/${key}: additional properties not allowed`);
      }
    }
  }

  return errors;
}

test('writeMeta outputs schema-compliant JSON with dataset hash', async () => {
  const tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'meta-json-test-'));
  const datasetPath = path.join(tmpDir, 'input.csv');
  await fs.writeFile(datasetPath, 'timestamp_utc,uid\n2024-01-01T00:00:00Z,user-1\n');

  const metaPath = path.join(tmpDir, 'meta.json');
  const metaInput = {
    algo_ver: algoVersion,
    epsilon: 0.0005,
    ntp_p95_ms: 12,
    ingress_jitter_ms: 5,
    fd_bins: { 'user-1': 64 },
    tau_otsu: { 'user-1': 0.45 },
    tau_knee: { 'user-1': 0.5 },
    tau_final: { 'user-1': 0.55 },
    DeltaT: { 'user-1': 13.2 },
    bimodality_test: { 'user-1': -1.2 },
    k: 2,
    scan_step: 0.05,
    hkdf_info: 'c2lk',
    kid: 'kid-sample-0001',
    datasetPath,
    thresholds_by_uid: { 'user-1': 13.2 }
  };

  const payload = await writeMeta(metaPath, metaInput);
  const raw = await fs.readFile(metaPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.deepEqual(parsed, payload);

  const schema = {
    type: 'object',
    required: [
      'algo_ver',
      'epsilon',
      'ntp_p95_ms',
      'ingress_jitter_ms',
      'fd_bins',
      'tau_otsu',
      'tau_knee',
      'tau_final',
      'DeltaT',
      'bimodality_test',
      'k',
      'scan_step',
      'hkdf_info',
      'kid',
      'dataset_hash',
      'thresholds_by_uid'
    ],
    additionalProperties: false,
    properties: {
      algo_ver: { type: 'string' },
      epsilon: { type: 'number' },
      ntp_p95_ms: { type: 'number' },
      ingress_jitter_ms: { type: 'number' },
      k: { type: 'number' },
      scan_step: { type: 'number' },
      hkdf_info: { type: 'string' },
      kid: { type: 'string' },
      dataset_hash: { type: 'string' },
      fd_bins: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: 'number' }
        }
      },
      tau_otsu: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: ['number', 'null'] }
        }
      },
      tau_knee: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: ['number', 'null'] }
        }
      },
      tau_final: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: 'number' }
        }
      },
      DeltaT: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: 'number' }
        }
      },
      bimodality_test: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: ['number', 'null'] }
        }
      },
      thresholds_by_uid: {
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '.*': { type: 'number' }
        }
      }
    }
  };

  const errors = validateAgainstSchema(schema, parsed);
  assert.deepEqual(errors, []);

  const expectedHash = createHash('sha256')
    .update(await fs.readFile(datasetPath))
    .digest('hex');
  assert.equal(parsed.dataset_hash, expectedHash);
});
