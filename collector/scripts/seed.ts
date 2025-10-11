import { config as loadEnv } from 'dotenv';
import { fetch } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';

loadEnv({ path: process.env.CONFIG_PATH || '.env' });

const FIXED_JWT_HMAC_KEY = 'c2VlZF9kZWZhdWx0X2p3dF9obWFjX2tleV8xMjM0NTY=';

if (!process.env.JWT_HMAC_KEY) {
  process.env.JWT_HMAC_KEY = FIXED_JWT_HMAC_KEY;
  console.info('[seed] JWT_HMAC_KEY was unset. Defaulting to reproducible fixture key.');
} else if (process.env.JWT_HMAC_KEY !== FIXED_JWT_HMAC_KEY) {
  console.warn('[seed] JWT_HMAC_KEY does not match the reproducible fixture key. Output may differ from reference statistics.');
}

const DEFAULT_BASE_URL = 'http://localhost:8000/api/v1/events';
const DEFAULT_SESSION_COUNT = 220;
const DEFAULT_INTERVAL_MS = 10;
const DEFAULT_START_TIMESTAMP = '2024-01-01T00:00:00.000Z';
const DEFAULT_SESSION_OFFSET_MS = 90_000;
const USER_POOL_SIZE = 18;

const baseUrl = process.env.SEED_BASE_URL || DEFAULT_BASE_URL;
const sessionCount = Number.parseInt(process.env.SEED_SESSION_COUNT || '', 10) || DEFAULT_SESSION_COUNT;
const intervalMs = Number.parseInt(process.env.SEED_INTERVAL_MS || '', 10) || DEFAULT_INTERVAL_MS;
const baseTimestamp = Date.parse(process.env.SEED_START_TIMESTAMP || DEFAULT_START_TIMESTAMP);
const sessionOffsetMs = Number.parseInt(process.env.SEED_SESSION_OFFSET_MS || '', 10) || DEFAULT_SESSION_OFFSET_MS;

if (Number.isNaN(baseTimestamp)) {
  throw new Error('Invalid SEED_START_TIMESTAMP; must be RFC 3339 (UTC).');
}

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const createRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const rng = createRng(0x5eedc0de);

const randomInt = (min: number, max: number): number => {
  const value = Math.floor(rng() * (max - min + 1)) + min;
  return value;
};

const randomChoice = <T>(items: T[]): T => {
  if (items.length === 0) {
    throw new Error('randomChoice received an empty array');
  }
  const index = Math.floor(rng() * items.length);
  return items[index];
};

const browsePaths = ['/dashboard', '/projects', '/analytics', '/audit/logs', '/reports/daily'];
const editPaths = ['/projects/alpha', '/projects/beta', '/settings/profile', '/settings/security'];
const referers = ['https://example.org/login', 'https://example.org/dashboard', 'https://example.org/alerts'];
const userAgents = [
  'seed-client/1.0 (undici)',
  'seed-client/1.0 (automation)',
  'seed-client/1.0 (load-test)',
];

interface EventStep {
  event: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  category: 'AUTH' | 'READ' | 'UPDATE';
  status: number;
}

interface SessionProfile {
  sessionId: string;
  jwt: string;
  userId: string;
}

const buildSessionProfile = (index: number): SessionProfile => {
  const userIndex = index % USER_POOL_SIZE;
  const userId = `user-${userIndex + 1}`;
  const jwt = encodeBase64Url(`${userId}|seed|${index}`);
  return {
    sessionId: `sess-${(index + 1).toString().padStart(5, '0')}`,
    jwt,
    userId,
  };
};

const buildTrace = (): EventStep[] => {
  const steps: EventStep[] = [
    { event: 'login', method: 'POST', path: '/auth/login', category: 'AUTH', status: 200 },
  ];

  const browseCount = randomInt(2, 5);
  for (let i = 0; i < browseCount; i += 1) {
    steps.push({ event: 'browse', method: 'GET', path: randomChoice(browsePaths), category: 'READ', status: 200 });
  }

  const editCount = randomInt(1, 3);
  for (let i = 0; i < editCount; i += 1) {
    steps.push({ event: 'edit', method: 'PUT', path: randomChoice(editPaths), category: 'UPDATE', status: 200 });
    if (rng() < 0.25) {
      steps.push({ event: 'browse', method: 'GET', path: randomChoice(browsePaths), category: 'READ', status: 200 });
    }
  }

  steps.push({ event: 'logout', method: 'POST', path: '/auth/logout', category: 'AUTH', status: 204 });
  return steps;
};

interface SeedStats {
  totalEvents: number;
  latencies: number[];
  perEvent: Map<string, number>;
}

const stats: SeedStats = {
  totalEvents: 0,
  latencies: [],
  perEvent: new Map<string, number>(),
};

const recordStats = (event: string, latency: number) => {
  stats.totalEvents += 1;
  stats.latencies.push(latency);
  stats.perEvent.set(event, (stats.perEvent.get(event) || 0) + 1);
};

const submitEvent = async (
  profile: SessionProfile,
  step: EventStep,
  timestamp: string,
  latencyMs: number,
  sequenceIndex: number
) => {
  const body = {
    session_id: profile.sessionId,
    user_id: profile.userId,
    jwt: profile.jwt,
    event: step.event,
    method: step.method,
    path: step.path,
    status: step.status,
    latency_ms: latencyMs,
    timestamp,
    metadata: {
      op_category: step.category,
      sequence_index: sequenceIndex,
      referer: randomChoice(referers),
      user_agent: randomChoice(userAgents),
    },
  };

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${profile.jwt}`,
      'user-agent': randomChoice(userAgents),
      referer: randomChoice(referers),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to submit event (${response.status}): ${text}`);
  }

  recordStats(step.event, latencyMs);
};

const runSession = async (sessionIndex: number) => {
  const profile = buildSessionProfile(sessionIndex);
  const trace = buildTrace();
  let timestampMs = baseTimestamp + sessionOffsetMs * sessionIndex;

  for (let i = 0; i < trace.length; i += 1) {
    const step = trace[i];
    const deltaSeconds = randomInt(3, 12);
    timestampMs += deltaSeconds * 1000;
    const latencyMs = randomInt(45, 480);
    const timestamp = new Date(timestampMs).toISOString();
    await submitEvent(profile, step, timestamp, latencyMs, i);
    if (intervalMs > 0) {
      await sleep(intervalMs);
    }
  }
};

const summarise = () => {
  const meanLatency =
    stats.latencies.reduce((accumulator, value) => accumulator + value, 0) / stats.latencies.length;
  const variance =
    stats.latencies.reduce((accumulator, value) => accumulator + (value - meanLatency) ** 2, 0) /
    stats.latencies.length;
  const stdLatency = Math.sqrt(variance);

  const distribution = Array.from(stats.perEvent.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.info('[seed] Sessions executed:', sessionCount);
  console.info('[seed] Total events inserted:', stats.totalEvents);
  for (const [event, count] of distribution) {
    console.info(`[seed]  - ${event}: ${count}`);
  }
  console.info('[seed] Latency mean (ms):', meanLatency.toFixed(2));
  console.info('[seed] Latency std (ms):', stdLatency.toFixed(2));
};

const main = async () => {
  console.info('[seed] Target:', baseUrl);
  console.info('[seed] Sessions to simulate:', sessionCount);
  console.info('[seed] Interval between requests (ms):', intervalMs);

  for (let i = 0; i < sessionCount; i += 1) {
    await runSession(i);
  }

  if (stats.totalEvents < 1000) {
    throw new Error(`Seed run produced ${stats.totalEvents} events (< 1000 required)`);
  }

  summarise();
};

main().catch((error) => {
  console.error('[seed] Generation failed:', error);
  process.exitCode = 1;
});
