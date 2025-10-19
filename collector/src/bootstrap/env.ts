import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromCollector = createRequire(path.resolve(__dirname, '../../../collector/package.json'));
const dotenv = requireFromCollector('dotenv') as typeof import('dotenv');

const HASH_KEYS = ['JWT_HMAC_KEY', 'LOG_DIR', 'CSV_ROTATION', 'APP_TIMEZONE', 'GPU_MODE', 'NODE_ENV'] as const;

const hashString = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const resolveEnvPath = (rawPath: string | undefined | null): string => {
  if (!rawPath) {
    return path.resolve(process.cwd(), '.env');
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return path.resolve(process.cwd(), '.env');
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
};

const envPath = resolveEnvPath(process.env.CONFIG_PATH);
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const computeConfigHash = (): string => {
  const snapshot = HASH_KEYS.map((key) => `${key}=${process.env[key] ?? ''}`).join('\n');
  return hashString(snapshot);
};

const readGitCommit = (): string => {
  try {
    const output = execSync('git rev-parse --short HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const normalized = output.trim();
    if (normalized) {
      return normalized;
    }
  } catch (error) {
    // ignore errors and fall through to unknown
  }
  return 'unknown';
};

export const BOOTSTRAP_CONFIG_HASH = computeConfigHash();
export const BOOTSTRAP_GIT_COMMIT = (() => {
  if (process.env.GIT_COMMIT && process.env.GIT_COMMIT.trim()) {
    return process.env.GIT_COMMIT.trim();
  }
  const commit = readGitCommit();
  process.env.GIT_COMMIT = commit;
  return commit;
})();

if (!process.env.CONFIG_HASH) {
  process.env.CONFIG_HASH = BOOTSTRAP_CONFIG_HASH;
}

console.info(`[collector] config_hash=${BOOTSTRAP_CONFIG_HASH} git_commit=${BOOTSTRAP_GIT_COMMIT}`);
