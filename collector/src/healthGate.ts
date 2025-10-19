import { promises as fs } from 'node:fs';
import path from 'node:path';

export class HealthError extends Error {
  code: 'NTP_OUT_OF_SPEC' | 'STALE_MEASUREMENT' | 'METRICS_INCONSISTENT';

  constructor(code: HealthError['code'], msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface NtpMeasurement {
  ntpP95Ms: number;
  lastMeasuredAt: number;
}

const DEFAULT_NTP_STATE_PATH = path.resolve(process.cwd(), 'state', 'ntp.json');

const coerceFiniteNumber = (value: unknown, label: string): number => {
  const candidate = typeof value === 'string' ? Number(value) : value;
  const numeric = typeof candidate === 'number' ? candidate : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw new HealthError('METRICS_INCONSISTENT', `${label} must be a finite number`);
  }
  return numeric;
};

const coerceTimestamp = (value: unknown, label: string): number => {
  if (value instanceof Date) {
    const epoch = value.getTime();
    if (Number.isNaN(epoch)) {
      throw new HealthError('METRICS_INCONSISTENT', `${label} is not a valid Date`);
    }
    return epoch;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new HealthError('METRICS_INCONSISTENT', `${label} cannot be empty`);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new HealthError('METRICS_INCONSISTENT', `${label} must be an ISO timestamp or epoch millis`);
};

export const assertHealthy = (
  ntpP95Ms: number,
  lastMeasuredAt: number,
  now: number = Date.now(),
  freshnessMs: number = 120_000,
): void => {
  if (!Number.isFinite(ntpP95Ms)) {
    throw new HealthError('METRICS_INCONSISTENT', 'ntp_p95_ms must be finite');
  }
  if (!Number.isFinite(lastMeasuredAt)) {
    throw new HealthError('METRICS_INCONSISTENT', 'lastMeasuredAt must be finite epoch milliseconds');
  }
  if (!Number.isFinite(now)) {
    throw new HealthError('METRICS_INCONSISTENT', 'now must be finite epoch milliseconds');
  }
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    throw new HealthError('METRICS_INCONSISTENT', 'freshnessMs must be a non-negative number');
  }

  if (ntpP95Ms > 50) {
    throw new HealthError('NTP_OUT_OF_SPEC', `ntp_p95_ms=${ntpP95Ms}ms > 50ms`);
  }

  if (now - lastMeasuredAt > freshnessMs) {
    throw new HealthError('STALE_MEASUREMENT', 'NTP measurement stale');
  }
};

export const normalizeNtpMeasurement = (input: unknown): NtpMeasurement => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HealthError('METRICS_INCONSISTENT', 'NTP state must be an object');
  }
  const payload = input as Record<string, unknown>;
  const ntpP95Ms = coerceFiniteNumber(payload.p95_ms, 'p95_ms');
  const lastMeasuredAt = coerceTimestamp(payload.lastMeasuredAt, 'lastMeasuredAt');
  return { ntpP95Ms, lastMeasuredAt };
};

export const readNtpState = async (statePath?: string | null): Promise<NtpMeasurement> => {
  const resolvedPath = statePath ? path.resolve(statePath) : DEFAULT_NTP_STATE_PATH;
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      throw new HealthError('STALE_MEASUREMENT', `NTP state not found at ${resolvedPath}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HealthError('METRICS_INCONSISTENT', `Failed to read NTP state at ${resolvedPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HealthError('METRICS_INCONSISTENT', `Invalid JSON in ${resolvedPath}: ${message}`);
  }

  return normalizeNtpMeasurement(parsed);
};

export { coerceFiniteNumber as coerceNumber, coerceTimestamp };
