import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';

const envPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

type Rotation = 'daily' | 'hourly';

type Nullable<T> = T | undefined | null;

const parseBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseOrigins = (raw: Nullable<string>): string[] => {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
};

const parseRotation = (value: unknown): Rotation => {
  if (!value) {
    return 'daily';
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'hourly' ? 'hourly' : 'daily';
};

const resolvePath = (rawValue: Nullable<string>, ...fallback: string[]): string => {
  if (rawValue && typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed) {
      return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    }
  }
  return path.resolve(process.cwd(), ...fallback);
};

export interface SecurityConfig {
  jwtHmacKey: string;
  kid: string;
}

export interface AuthConfig {
  required: boolean;
  audience?: string;
  issuer?: string;
}

export interface CorsConfig {
  allowedOrigins: string[];
}

export interface PaginationConfig {
  defaultLimit: number;
  maxLimit: number;
}

export interface AppConfig {
  env: string;
  port: number;
  requestLimit: string;
  sqlitePath: string;
  csvRoot: string;
  simLogRoot: string;
  csvRotation: Rotation;
  jwtSecret: string;
  security: SecurityConfig;
  auth: AuthConfig;
  cors: CorsConfig;
  pagination: PaginationConfig;
}

const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT ?? '', 10) || 8000,
  requestLimit: process.env.REQUEST_LIMIT || '2mb',
  sqlitePath: resolvePath(process.env.SQLITE_PATH, 'data', 'db', 'events.sqlite3'),
  csvRoot: resolvePath(process.env.LOG_DIR || process.env.CSV_ROOT, 'data', 'raw'),
  simLogRoot: resolvePath(process.env.SIM_LOG_DIR, 'data', 'sim'),
  csvRotation: parseRotation(process.env.CSV_ROTATION),
  jwtSecret: process.env.JWT_SECRET || '',
  security: {
    jwtHmacKey: process.env.JWT_HMAC_KEY || '',
    kid: process.env.SID_KEY_ID || process.env.JWT_KEY_ID || '',
  },
  auth: {
    required: parseBool(process.env.REQUIRE_AUTH, false),
    audience: process.env.JWT_AUDIENCE || undefined,
    issuer: process.env.JWT_ISSUER || undefined,
  },
  cors: {
    allowedOrigins: parseOrigins(process.env.CORS_ORIGINS),
  },
  pagination: {
    defaultLimit: Number.parseInt(process.env.PAGE_LIMIT ?? '', 10) || 100,
    maxLimit: Number.parseInt(process.env.PAGE_MAX_LIMIT ?? '', 10) || 500,
  },
};

export default config;
