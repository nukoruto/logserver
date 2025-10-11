const path = require('path');
const fs = require('fs');

const envPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: envPath });
}

const parseBool = (value, fallback = false) => {
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

const parseOrigins = (raw) => {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT, 10) || 8000,
  requestLimit: process.env.REQUEST_LIMIT || '2mb',
  sqlitePath:
    process.env.SQLITE_PATH ||
    path.resolve(process.cwd(), 'data', 'db', 'events.sqlite3'),
  csvRoot: process.env.CSV_ROOT || path.resolve(process.cwd(), 'data', 'raw'),
  jwtSecret: process.env.JWT_SECRET || '',
  security: {
    jwtHmacKey: process.env.JWT_HMAC_KEY || '',
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
    defaultLimit: Number.parseInt(process.env.PAGE_LIMIT, 10) || 100,
    maxLimit: Number.parseInt(process.env.PAGE_MAX_LIMIT, 10) || 500,
  },
};

module.exports = config;
