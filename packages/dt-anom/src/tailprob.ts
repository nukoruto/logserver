import { clamp } from './utils.js';

export interface TailProbabilityOptions {
  readonly xi: number;
  readonly beta: number;
  readonly threshold: number;
}

export interface TailProbabilityResult {
  readonly survival: number;
  readonly excess: number;
}

export function computeTailProbability(value: number, options: TailProbabilityOptions): TailProbabilityResult {
  const excess = value - options.threshold;
  if (excess <= 0) {
    return { survival: 1, excess: 0 };
  }
  const xi = options.xi;
  const beta = Math.max(options.beta, 1e-12);
  if (Math.abs(xi) < 1e-9) {
    const survival = Math.exp(-excess / beta);
    return { survival, excess };
  }
  const inside = 1 + (xi * excess) / beta;
  if (inside <= 0) {
    return { survival: 0, excess };
  }
  const survival = Math.pow(inside, -1 / xi);
  return { survival: clamp(survival, 0, 1), excess };
}

export function negativeLog10(value: number): number {
  if (value <= 0) {
    return 16; // cap at large score
  }
  return -Math.log10(value);
}
