import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const JWT_KEY = 'c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=';
const JWT_PATTERN = /eyJ[0-9A-Za-z_-]{10,}/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
const SPLIT_SESSIONS_BIN = path.join(DIST_DIR, 'bulk.js');
const SESSION_SPLITTER_BIN = path.join(DIST_DIR, 'index.js');
const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures');

interface SplitScenario {
  name: string;
  kid: string;
  epsilon: string;
  k: string;
  scanStep: string;
  minEvents: string;
}

const SPLIT_SCENARIOS: SplitScenario[] = [
  { name: 'unimodal', kid: 'SCN-UNIMODAL', epsilon: '0.001', k: '2', scanStep: '0.05', minEvents: '1' },
  { name: 'bimodal', kid: 'SCN-BIMODAL', epsilon: '0.001', k: '2', scanStep: '0.05', minEvents: '1' },
  { name: 'noisy', kid: 'SCN-NOISY', epsilon: '0.001', k: '2', scanStep: '0.05', minEvents: '1' },
  { name: 'sparse', kid: 'SCN-SPARSE', epsilon: '0.001', k: '2', scanStep: '0.05', minEvents: '1' },
];

function ensureNoJwt(label: string, content: string): void {
  assert.equal(JWT_PATTERN.test(content), false, `${label} unexpectedly contains JWT-like payload`);
}

async function runNodeScript(
  scriptPath: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...envOverrides },
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
  const [code] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  return { code: code ?? 0, stdout, stderr };
}

for (const scenario of SPLIT_SCENARIOS) {
  test(`split-sessions golden parity (${scenario.name})`, { concurrency: false }, async () => {
    const scenarioRoot = path.join(FIXTURES_ROOT, scenario.name);
    const expectedCsvPath = path.join(scenarioRoot, 'expected', 'output.csv');
    const expectedMetaPath = path.join(scenarioRoot, 'expected', 'meta.json');
    const inputSource = path.join(scenarioRoot, 'input.csv');

    const tempDir = await mkdtemp(path.join(tmpdir(), `split-sessions-${scenario.name}-`));
    const inputPath = path.join(tempDir, 'input.csv');
    const outputPath = path.join(tempDir, 'output.csv');
    const metaPath = path.join(tempDir, 'meta.json');

    try {
      await cp(inputSource, inputPath, { dereference: true });

      const args = [
        '--in', inputPath,
        '--out', outputPath,
        '--meta', metaPath,
        '--epsilon', scenario.epsilon,
        '--k', scenario.k,
        '--scan-step', scenario.scanStep,
        '--min-events', scenario.minEvents,
        '--kid', scenario.kid,
        '--algo', 'otsu+kneedle-v1',
      ];

      const { code, stdout, stderr } = await runNodeScript(SPLIT_SESSIONS_BIN, args, {
        JWT_HMAC_KEY: JWT_KEY,
      });

      assert.equal(code, 0, `split-sessions exited with ${code}. stderr=${stderr}`);
      assert.equal(stdout, '', 'split-sessions should not emit stdout');
      ensureNoJwt('split-sessions stderr', stderr);

      const actualCsv = await readFile(outputPath, 'utf8');
      const expectedCsv = await readFile(expectedCsvPath, 'utf8');
      assert.equal(actualCsv, expectedCsv, 'augmented CSV differs from golden');
      ensureNoJwt('split-sessions CSV', actualCsv);

      const actualMeta = JSON.parse(await readFile(metaPath, 'utf8'));
      const expectedMeta = JSON.parse(await readFile(expectedMetaPath, 'utf8'));
      assert.deepEqual(actualMeta, expectedMeta, 'meta.json payload differs from golden');
      ensureNoJwt('split-sessions meta', JSON.stringify(actualMeta));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test('session-splitter CLI respects ntp offset and secrecy', { concurrency: false }, async () => {
  const scenario = 'ntp_offset';
  const scenarioRoot = path.join(FIXTURES_ROOT, scenario);
  const inputSource = path.join(scenarioRoot, 'input.csv');
  const expectedMetaPath = path.join(scenarioRoot, 'expected', 'meta.json');
  const expectedStdoutPath = path.join(scenarioRoot, 'expected', 'stdout.jsonl');

  const tempDir = await mkdtemp(path.join(tmpdir(), `session-splitter-${scenario}-`));
  const inputPath = path.join(tempDir, 'input.csv');
  const metaPath = path.join(tempDir, 'meta.json');

  try {
    await cp(inputSource, inputPath, { dereference: true });

    const args = [
      '--input', inputPath,
      '--format', 'json',
      '--thresholds',
      '--meta', metaPath,
      '--epsilon', '0.001',
      '--ntp-p95-ms', '1250',
      '--ingress-jitter-ms', '45',
    ];

    const { code, stdout, stderr } = await runNodeScript(SESSION_SPLITTER_BIN, args, {
      JWT_HMAC_KEY: JWT_KEY,
    });

    assert.equal(code, 0, `session-splitter exited with ${code}. stderr=${stderr}`);
    ensureNoJwt('session-splitter stderr', stderr);

    const actualStdout = stdout.replace(/\r/g, '');
    const expectedStdout = await readFile(expectedStdoutPath, 'utf8');
    assert.equal(actualStdout, expectedStdout, 'session-splitter stdout differs from golden');
    ensureNoJwt('session-splitter stdout', actualStdout);

    const actualMeta = JSON.parse(await readFile(metaPath, 'utf8'));
    const expectedMeta = JSON.parse(await readFile(expectedMetaPath, 'utf8'));
    assert.deepEqual(actualMeta, expectedMeta, 'session-splitter meta.json differs from golden');
    ensureNoJwt('session-splitter meta', JSON.stringify(actualMeta));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('split-sessions fails fast when JWT key is missing', { concurrency: false }, async () => {
  const scenarioRoot = path.join(FIXTURES_ROOT, 'unimodal');
  const inputSource = path.join(scenarioRoot, 'input.csv');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'split-sessions-missing-key-'));
  const inputPath = path.join(tempDir, 'input.csv');
  const outputPath = path.join(tempDir, 'output.csv');
  const metaPath = path.join(tempDir, 'meta.json');

  try {
    await cp(inputSource, inputPath, { dereference: true });

    const args = [
      '--in', inputPath,
      '--out', outputPath,
      '--meta', metaPath,
      '--epsilon', '0.001',
      '--k', '2',
      '--scan-step', '0.05',
      '--min-events', '1',
      '--kid', 'SCN-UNIMODAL',
      '--algo', 'otsu+kneedle-v1',
    ];

    const { code, stdout, stderr } = await runNodeScript(SPLIT_SESSIONS_BIN, args, {
      JWT_HMAC_KEY: '',
    });

    assert.notEqual(code, 0, 'split-sessions should fail without JWT key');
    assert.equal(stdout, '', 'split-sessions should not emit stdout on error');
    assert.match(stderr, /JWT_HMAC_KEY environment variable is required/);
    ensureNoJwt('split-sessions stderr (missing key)', stderr);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
