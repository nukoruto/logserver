const MAX_CLIP_BOUND = 1e6;

function normalizeBound(bound: number): number {
  if (!Number.isFinite(bound) || bound <= 0) {
    return 0;
  }
  return Math.min(bound, MAX_CLIP_BOUND);
}

function sanitizeDelta(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function sanitizeEpsilon(eps: number): number {
  if (!Number.isFinite(eps) || eps <= 0) {
    return Number.EPSILON;
  }
  return eps;
}

export function clip(value: number, bound: number): number {
  const limit = normalizeBound(Math.abs(bound));
  if (limit === 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) {
      return 0;
    }
    return value > 0 ? limit : -limit;
  }
  if (value > limit) {
    return limit;
  }
  if (value < -limit) {
    return -limit;
  }
  return value;
}

export function lburst(dtPrev: number, dtNow: number, eps: number, b = 5): number {
  const prev = sanitizeDelta(dtPrev);
  const current = sanitizeDelta(dtNow);
  const epsilon = sanitizeEpsilon(eps);

  const numerator = prev + epsilon;
  const denominator = current + epsilon;

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return 0;
  }

  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0;
  }

  const value = Math.log(ratio);
  return clip(value, b);
}
