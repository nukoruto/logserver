import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const FIXTURE_JWT_KEY = 'c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=';
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST_CLI_PATH = path.join(PACKAGE_ROOT, 'dist', 'bulk.js');
const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures');

async function runCli(args, options = {}) {
  const child = spawn(process.execPath, [DIST_CLI_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JWT_HMAC_KEY: FIXTURE_JWT_KEY },
    ...options
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('split-sessions CLI produces golden CSV and meta', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(tmpdir(), 'split-cli-'));
  const inputPath = path.join(tmpDir, 'logs.csv');
  const outputPath = path.join(tmpDir, 'logs_session.csv');
  const metaPath = path.join(tmpDir, 'meta.json');
  await fs.copyFile(path.join(FIXTURE_DIR, 'logs.csv'), inputPath);

  const args = [
    '--in', inputPath,
    '--out', outputPath,
    '--meta', metaPath,
    '--epsilon', '0.001',
    '--k', '2',
    '--scan-step', '0.05',
    '--min-events', '2',
    '--kid', 'DS-TEST-001',
    '--algo', 'otsu+kneedle-v1'
  ];

  const { code, stdout, stderr } = await runCli(args);
  assert.equal(code, 0, `Expected exit code 0, got ${code}. stderr=${stderr}`);
  assert.equal(stdout, '');
  assert.match(stderr, /split-sessions\]/);

  const outputCsv = await fs.readFile(outputPath, 'utf8');
  const expectedCsv = await fs.readFile(path.join(FIXTURE_DIR, 'golden', 'logs_session.csv'), 'utf8');
  assert.equal(outputCsv, expectedCsv);

  const metaJson = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const expectedMeta = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, 'golden', 'meta.json'), 'utf8'));
  assert.deepEqual(metaJson, expectedMeta);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
