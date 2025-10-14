import { createHash } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function toFiniteNumber(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new TypeError(`${name} must be a finite number`);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new Error('Division by zero');
  }
  return numerator / denominator;
}

export function computeHashHex(content: string): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

export function parseQuantileLevels(levels: readonly number[]): number[] {
  return Array.from(
    new Set(
      levels
        .map((level) => Number(level))
        .filter((level) => Number.isFinite(level) && level > 0 && level < 1)
        .sort((a, b) => a - b)
    )
  );
}

export interface RunningMoments {
  readonly count: number;
  readonly mean: number;
  readonly m2: number;
}

export function updateRunningMoments(stats: RunningMoments, value: number): RunningMoments {
  const delta = value - stats.mean;
  const count = stats.count + 1;
  const mean = stats.mean + delta / count;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;
  return { count, mean, m2 };
}

export function createRunningMoments(): RunningMoments {
  return { count: 0, mean: 0, m2: 0 };
}

export function finalizeStd(stats: RunningMoments): number {
  if (stats.count < 2) {
    return 0;
  }
  return Math.sqrt(stats.m2 / (stats.count - 1));
}
