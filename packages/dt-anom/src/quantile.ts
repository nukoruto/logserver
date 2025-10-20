import { quantileSorted } from 'simple-statistics';

export interface QuantileSummary {
  readonly p: number;
  readonly value: number;
}

export function computeQuantiles(sortedValues: readonly number[], levels: readonly number[]): QuantileSummary[] {
  const values = Array.from(sortedValues);
  return levels.map((p) => ({ p, value: quantileSorted(values, p) }));
}

export function ensureSorted(values: readonly number[]): number[] {
  const copy = values.slice();
  copy.sort((a, b) => a - b);
  return copy;
}
