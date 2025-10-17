export function chooseEpsilonMin(deltas: readonly number[]): number {
  const xs = deltas.filter((x) => x > 0 && Number.isFinite(x));
  if (xs.length === 0) {
    return 1e-3;
  }
  const m = Math.min(...xs);
  const eps = 0.5 * m;
  return Math.max(1e-6, Math.min(eps, 1e-2));
}
