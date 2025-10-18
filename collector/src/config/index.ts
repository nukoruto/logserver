import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';

const envPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

type Nullable<T> = T | undefined | null;

const resolvePath = (rawValue: Nullable<string>, ...fallback: string[]): string => {
  if (rawValue && typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed) {
      return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    }
  }
  return path.resolve(process.cwd(), ...fallback);
};

const clampNumber = (value: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return value;
};

const parsePositiveNumber = (rawValue: Nullable<string>): number | null => {
  if (!rawValue) {
    return null;
  }
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  return null;
};

const normalizeTimeAnomalyMode = (rawValue: Nullable<string>): 'auto' | 'propagate' | 'local' | null => {
  if (typeof rawValue !== 'string') {
    return null;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'propagate' || normalized === 'local') {
    return normalized;
  }
  return null;
};

const DEFAULT_DELTA_EPSILON = 1e-3;
const MIN_DELTA_EPSILON = 1e-6;
const MAX_DELTA_EPSILON = 1;
const DEFAULT_TIME_ANOMALY_MODE: 'auto' | 'propagate' | 'local' = 'auto';

const resolvedDeltaEpsilon = clampNumber(
  parsePositiveNumber(process.env.SIM_DELTA_EPSILON) ?? DEFAULT_DELTA_EPSILON,
  MIN_DELTA_EPSILON,
  MAX_DELTA_EPSILON,
);

const resolvedTimeAnomalyMode = normalizeTimeAnomalyMode(process.env.SIM_TIME_ANOMALY_MODE) ?? DEFAULT_TIME_ANOMALY_MODE;

export interface AppConfig {
  env: string;
  simLogRoot: string;
  deltaEpsilon: number;
  timeAnomalyMode: 'auto' | 'propagate' | 'local';
}

const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  simLogRoot: resolvePath(process.env.SIM_LOG_DIR, 'data', 'sim'),
  deltaEpsilon: resolvedDeltaEpsilon,
  timeAnomalyMode: resolvedTimeAnomalyMode,
};

export default config;
