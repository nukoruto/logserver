import '../bootstrap/env';
import { createHash } from 'node:crypto';

const hashString = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

type EnvHashKeys = 'LOG_DIR' | 'APP_TIMEZONE' | 'GPU_MODE' | 'JWT_HMAC_KEY';

type MetricsSnapshot = {
  ts_utc: string;
  git_commit: string;
  env_hash: Record<EnvHashKeys, string>;
  config_hash: string;
};

const ENV_HASH_KEYS: EnvHashKeys[] = ['LOG_DIR', 'APP_TIMEZONE', 'GPU_MODE', 'JWT_HMAC_KEY'];
const CONFIG_HASH_KEYS = ['JWT_HMAC_KEY', 'LOG_DIR', 'CSV_ROTATION', 'APP_TIMEZONE', 'GPU_MODE', 'NODE_ENV'];

export const collectMetricsSnapshot = (): MetricsSnapshot => {
  const env = process.env;
  const envHash = ENV_HASH_KEYS.reduce<Record<EnvHashKeys, string>>((acc, key) => {
    acc[key] = hashString(env[key] ?? '');
    return acc;
  }, {
    LOG_DIR: '',
    APP_TIMEZONE: '',
    GPU_MODE: '',
    JWT_HMAC_KEY: '',
  });

  const configPayload = CONFIG_HASH_KEYS.map((key) => `${key}=${env[key] ?? ''}`).join('\n');

  return {
    ts_utc: new Date().toISOString(),
    git_commit: env.GIT_COMMIT || 'unknown',
    env_hash: envHash,
    config_hash: hashString(configPayload),
  };
};
