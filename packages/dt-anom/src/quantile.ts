import { quantileSorted } from 'simple-statistics';

export interface QuantileSummary {
  readonly p: number;
  readonly value: number;
}

export function computeQuantiles(sortedValues: readonly number[], levels: readonly number[]): QuantileSummary[] {
  return levels.map((p) => ({ p, value: quantileSorted(sortedValues, p) }));
}

export function ensureSorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}
