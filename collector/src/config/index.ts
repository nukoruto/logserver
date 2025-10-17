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

export interface AppConfig {
  env: string;
  simLogRoot: string;
}

const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  simLogRoot: resolvePath(process.env.SIM_LOG_DIR, 'data', 'sim'),
};

export default config;
