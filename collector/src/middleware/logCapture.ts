import config from '../config';
import { jwtToUid } from '../security/uid';

type HeaderValue = string | string[] | undefined;

type Headers = Record<string, HeaderValue>;

type RequestLike = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Headers;
  ip?: string;
  ips?: string[];
  socket?: { remoteAddress?: string | null } | null;
  connection?: { remoteAddress?: string | null } | null;
  session?: { id?: string | null } | null;
  sessionID?: string | null;
  get?: (name: string) => string | undefined;
  user?: Record<string, unknown> | null;
};

type ResponseLike = {
  locals: Record<string, unknown>;
};

type NextLike = (err?: unknown) => void;

type Middleware = (req: RequestLike, res: ResponseLike, next: NextLike) => void;

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

const ensureLocals = (res: ResponseLike): void => {
  if (!res.locals || typeof res.locals !== 'object') {
    res.locals = {};
  }
};

const firstHeaderValue = (value: HeaderValue): string => {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
};

const normalise = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const parseCookies = (cookieHeader: string): Record<string, string> => {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, part) => {
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
};

const extractSessionId = (req: RequestLike, cookieHeader: string): string => {
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
      const candidate = (req.user as Record<string, unknown>)[key];
      const value = normalise(candidate as string | undefined);
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

const extractClientIp = (req: RequestLike): string => {
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

const extractUid = (authorizationHeader: string): string => {
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

const deleteHeader = (headers: Headers, name: string): void => {
  if (!headers) {
    return;
  }
  delete headers[name];
  delete headers[name.toLowerCase()];
  delete headers[name.toUpperCase()];
};

const logCapture: Middleware = (req, res, next) => {
  const headers = req.headers || {};
  const authorization = firstHeaderValue(headers[HEADER_AUTHORIZATION]);
  const cookie = firstHeaderValue(headers[HEADER_COOKIE]);

  ensureLocals(res);

  const logframe = {
    timestamp_utc: new Date().toISOString(),
    method: normalise(req.method) || '',
    path: normalise(req.originalUrl || req.url) || '',
    referer:
      normalise(firstHeaderValue(headers[HEADER_REFERRER])) ||
      normalise(firstHeaderValue(headers[HEADER_REFERRER_FALLBACK])) ||
      '',
    user_agent: normalise(firstHeaderValue(headers[HEADER_USER_AGENT])) || '',
    ip: extractClientIp(req),
    session_id: extractSessionId(req, cookie),
    uid: extractUid(authorization),
    op_category: '',
  };

  res.locals.__logframe = logframe;

  deleteHeader(headers, HEADER_AUTHORIZATION);
  deleteHeader(headers, HEADER_COOKIE);

  next();
};

export { logCapture };
export default logCapture;
