const config = require('../config');
const { jwtToUid } = require('../security/uid');
const {
  DEFAULT_OPERATION_CATEGORY,
  HTTP_METHODS,
  LogRecordValidationError,
} = require('../schema/logRecord');

const HEADER_AUTHORIZATION = 'authorization';
const HEADER_COOKIE = 'cookie';
const HEADER_XFF = 'x-forwarded-for';
const HEADER_REFERRER = 'referer';
const HEADER_REFERRER_FALLBACK = 'referrer';
const HEADER_USER_AGENT = 'user-agent';

const SESSION_HEADER_CANDIDATES = ['x-session-id', 'x-session', 'x-sessionid', 'x-app-session'];
const SESSION_COOKIE_CANDIDATES = ['session_id', 'sid', 'connect.sid'];
const USER_SESSION_KEYS = ['session_id', 'sessionId', 'sid'];

const BEARER_PREFIX = /^Bearer\s+/i;

const ensureLocals = (res) => {
  if (!res.locals || typeof res.locals !== 'object') {
    res.locals = {};
  }
};

const firstHeaderValue = (value) => {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
};

const normalise = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const parseCookies = (cookieHeader) =>
  cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return accumulator;
      }
      const key = part.slice(0, separatorIndex).trim();
      const rawValue = part.slice(separatorIndex + 1).trim();
      if (!key) {
        return accumulator;
      }
      try {
        accumulator[key] = decodeURIComponent(rawValue);
      } catch (error) {
        accumulator[key] = rawValue;
      }
      return accumulator;
    }, {});

const extractSessionId = (req, cookieHeader) => {
  if (req.session && typeof req.session === 'object' && req.session.id) {
    const value = normalise(req.session.id);
    if (value) {
      return value;
    }
  }

  if (req.sessionID) {
    const value = normalise(req.sessionID);
    if (value) {
      return value;
    }
  }

  if (req.user && typeof req.user === 'object') {
    for (const key of USER_SESSION_KEYS) {
      const candidate = req.user[key];
      const value = normalise(candidate);
      if (value) {
        return value;
      }
    }
  }

  for (const headerName of SESSION_HEADER_CANDIDATES) {
    const value = normalise(firstHeaderValue(req.headers?.[headerName]));
    if (value) {
      return value;
    }
  }

  const cookies = cookieHeader ? parseCookies(cookieHeader) : {};
  for (const cookieName of SESSION_COOKIE_CANDIDATES) {
    const value = normalise(cookies[cookieName]);
    if (value) {
      return value;
    }
  }

  return '';
};

const extractClientIp = (req) => {
  const forwarded = normalise(firstHeaderValue(req.headers?.[HEADER_XFF]));
  if (forwarded) {
    const primary = forwarded.split(',')[0]?.trim();
    if (primary) {
      return primary;
    }
  }

  if (Array.isArray(req.ips) && req.ips.length > 0) {
    const primary = normalise(req.ips[0]);
    if (primary) {
      return primary;
    }
  }

  if (req.ip) {
    const value = normalise(req.ip);
    if (value) {
      return value;
    }
  }

  const remoteFromSocket = req.socket?.remoteAddress;
  if (remoteFromSocket) {
    const value = normalise(remoteFromSocket);
    if (value) {
      return value;
    }
  }

  const remoteFromConnection = req.connection?.remoteAddress;
  if (remoteFromConnection) {
    const value = normalise(remoteFromConnection);
    if (value) {
      return value;
    }
  }

  return '';
};

const extractUid = (authorizationHeader) => {
  const trimmed = authorizationHeader.trim();
  if (!trimmed) {
    return '';
  }
  if (!BEARER_PREFIX.test(trimmed)) {
    return '';
  }
  const token = trimmed.replace(BEARER_PREFIX, '').trim();
  if (!token) {
    return '';
  }
  const hmacKey = config.security?.jwtHmacKey;
  if (!hmacKey) {
    return '';
  }
  try {
    return jwtToUid(token, hmacKey);
  } catch (error) {
    return '';
  }
};

const deleteHeader = (headers, name) => {
  if (!headers) {
    return;
  }
  delete headers[name];
  delete headers[name.toLowerCase()];
  delete headers[name.toUpperCase()];
};

const ALLOWED_METHODS = new Set(HTTP_METHODS);

const logCapture = (req, res, next) => {
  const headers = req.headers || {};
  const authorization = firstHeaderValue(headers[HEADER_AUTHORIZATION]);
  const cookie = firstHeaderValue(headers[HEADER_COOKIE]);

  ensureLocals(res);

  const rawMethod = normalise(req.method) || '';
  const method = rawMethod.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    const error = new LogRecordValidationError('Unsupported HTTP method for log capture', [
      {
        path: ['method'],
        message: `method must be one of ${HTTP_METHODS.join(', ')}`,
        expected: HTTP_METHODS,
        received: rawMethod || req.method,
      },
    ]);
    next(error);
    return;
  }

  const logframe = {
    timestamp_utc: new Date().toISOString(),
    method,
    path: normalise(req.originalUrl || req.url) || '',
    referer:
      normalise(firstHeaderValue(headers[HEADER_REFERRER])) ||
      normalise(firstHeaderValue(headers[HEADER_REFERRER_FALLBACK])) ||
      '',
    user_agent: normalise(firstHeaderValue(headers[HEADER_USER_AGENT])) || '',
    ip: extractClientIp(req),
    session_id: extractSessionId(req, cookie),
    uid: extractUid(authorization),
    op_category: DEFAULT_OPERATION_CATEGORY,
  };

  res.locals.__logframe = logframe;

  deleteHeader(headers, HEADER_AUTHORIZATION);
  deleteHeader(headers, HEADER_COOKIE);

  next();
};

module.exports = logCapture;
module.exports.logCapture = logCapture;
