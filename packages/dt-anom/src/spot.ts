import { quantileSorted } from 'simple-statistics';
import { declusterExceedances } from './decluster.js';
import { clamp, createRunningMoments, updateRunningMoments } from './utils.js';

export interface SpotSample {
  readonly value: number;
  readonly index: number;
}

export interface SpotCalibrateOptions {
  readonly minTailCount: number;
  readonly xiEps: number;
  readonly declusterR: number;
  readonly q: number;
}

export type SpotEstimatorType = 'mle' | 'pwm' | 'mom' | 'quantile';

export interface SpotCalibrationDiagnostics {
  readonly estimator: SpotEstimatorType;
  readonly warnings: readonly string[];
  readonly fallbackUsed: boolean;
  readonly usedPrevious?: boolean;
  readonly error?: string;
}

export interface SpotCalibrateResult {
  readonly quantile: number;
  readonly threshold: number;
  readonly xi: number;
  readonly beta: number;
  readonly theta: number;
  readonly pRef: number;
  readonly calibrationSize: number;
  readonly meanResidual: number;
  readonly qStar: number;
  readonly diagnostics?: SpotCalibrationDiagnostics;
}

interface SpotCandidate {
  readonly quantile: number;
  readonly threshold: number;
  readonly xi: number;
  readonly beta: number;
  readonly theta: number;
  readonly pRef: number;
  readonly calibrationSize: number;
  readonly meanResidual: number;
  readonly qStar: number;
  readonly stability: number;
  readonly estimator: SpotEstimatorType;
  readonly warnings: readonly string[];
}

interface NelderMeadPoint {
  point: [number, number];
  value: number;
}

const NELDER_MEAD_ALPHA = 1;
const NELDER_MEAD_GAMMA = 2;
const NELDER_MEAD_RHO = 0.5;
const NELDER_MEAD_SIGMA = 0.5;
const NELDER_MEAD_MAX_ITER = 200;
const NELDER_MEAD_TOL = 1e-6;

function gpdNegativeLogLikelihood(xi: number, beta: number, exceedances: readonly number[]): number {
  if (!(Number.isFinite(xi) && Number.isFinite(beta)) || beta <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (Math.abs(xi) < 1e-9) {
    let sum = 0;
    for (const y of exceedances) {
      if (y < 0) {
        return Number.POSITIVE_INFINITY;
      }
      sum += y;
    }
    return exceedances.length * Math.log(beta) + sum / beta;
  }
  const invXi = 1 / xi;
  const coeff = 1 + invXi;
  let sumLog = 0;
  for (const y of exceedances) {
    if (y < 0) {
      return Number.POSITIVE_INFINITY;
    }
    const inside = 1 + (xi * y) / beta;
    if (inside <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    sumLog += Math.log(inside);
  }
  return exceedances.length * Math.log(beta) + coeff * sumLog;
}

function estimateInitialParameters(exceedances: readonly number[]): { xi: number; beta: number } {
  const moments = createRunningMoments();
  let running = moments;
  for (const value of exceedances) {
    running = updateRunningMoments(running, value);
  }
  const mean = running.mean;
  const variance = running.count >= 2 ? running.m2 / (running.count - 1) : 0;
  if (variance <= 0 || !Number.isFinite(variance)) {
    return { xi: 0.1, beta: Math.max(mean, 1e-6) };
  }
  const ratio = (mean * mean) / variance;
  const xi = clamp((1 - ratio) / 2, -0.45, 0.9);
  const beta = Math.max(mean * (1 - xi), 1e-6);
  return { xi, beta };
}

function nelderMead(
  objective: (xi: number, beta: number) => number,
  initialXi: number,
  initialBeta: number
): { xi: number; beta: number } {
  const simplex: NelderMeadPoint[] = [];
  const deltaXi = initialXi !== 0 ? Math.abs(initialXi) * 0.2 : 0.05;
  const deltaLogBeta = 0.2;
  const initialLogBeta = Math.log(Math.max(initialBeta, 1e-6));
  const startPoints: [number, number][] = [
    [initialXi, initialLogBeta],
    [initialXi + deltaXi, initialLogBeta],
    [initialXi, initialLogBeta + deltaLogBeta]
  ];
  for (const point of startPoints) {
    simplex.push({ point, value: objective(point[0], Math.exp(point[1])) });
  }
  for (let iter = 0; iter < NELDER_MEAD_MAX_ITER; iter += 1) {
    simplex.sort((a, b) => a.value - b.value);
    const best = simplex[0];
    const worst = simplex[2];
    const second = simplex[1];
    const maxDiff = Math.max(
      Math.abs(best.value - worst.value),
      Math.abs(best.value - second.value),
      Math.abs(second.value - worst.value)
    );
    if (maxDiff < NELDER_MEAD_TOL) {
      break;
    }
    const centroidXi = (best.point[0] + second.point[0]) / 2;
    const centroidLogBeta = (best.point[1] + second.point[1]) / 2;
    const reflected: [number, number] = [
      centroidXi + NELDER_MEAD_ALPHA * (centroidXi - worst.point[0]),
      centroidLogBeta + NELDER_MEAD_ALPHA * (centroidLogBeta - worst.point[1])
    ];
    const reflectedValue = objective(reflected[0], Math.exp(reflected[1]));
    if (reflectedValue < second.value && reflectedValue >= best.value) {
      simplex[2] = { point: reflected, value: reflectedValue };
      continue;
    }
    if (reflectedValue < best.value) {
      const expanded: [number, number] = [
        centroidXi + NELDER_MEAD_GAMMA * (reflected[0] - centroidXi),
        centroidLogBeta + NELDER_MEAD_GAMMA * (reflected[1] - centroidLogBeta)
      ];
      const expandedValue = objective(expanded[0], Math.exp(expanded[1]));
      simplex[2] = expandedValue < reflectedValue ? { point: expanded, value: expandedValue } : { point: reflected, value: reflectedValue };
      continue;
    }
    const contracted: [number, number] = [
      centroidXi + NELDER_MEAD_RHO * (worst.point[0] - centroidXi),
      centroidLogBeta + NELDER_MEAD_RHO * (worst.point[1] - centroidLogBeta)
    ];
    const contractedValue = objective(contracted[0], Math.exp(contracted[1]));
    if (contractedValue < worst.value) {
      simplex[2] = { point: contracted, value: contractedValue };
      continue;
    }
    const bestPoint = simplex[0].point;
    for (let i = 1; i < simplex.length; i += 1) {
      const xi = bestPoint[0] + NELDER_MEAD_SIGMA * (simplex[i].point[0] - bestPoint[0]);
      const logBeta = bestPoint[1] + NELDER_MEAD_SIGMA * (simplex[i].point[1] - bestPoint[1]);
      simplex[i] = {
        point: [xi, logBeta],
        value: objective(xi, Math.exp(logBeta))
      };
    }
  }
  simplex.sort((a, b) => a.value - b.value);
  const resultXi = clamp(simplex[0].point[0], -0.9, 0.95);
  const resultBeta = Math.max(Math.exp(simplex[0].point[1]), 1e-9);
  return { xi: resultXi, beta: resultBeta };
}

function fitGpdMle(exceedances: readonly number[], xiEps: number): { xi: number; beta: number } {
  if (exceedances.length === 0) {
    throw new Error('Cannot fit GPD without exceedances');
  }
  const filtered = exceedances.filter((value) => Number.isFinite(value) && value >= 0);
  if (filtered.length === 0) {
    throw new Error('No valid exceedances for GPD fit');
  }
  const { xi: initialXi, beta: initialBeta } = estimateInitialParameters(filtered);
  const objective = (xi: number, beta: number) => {
    const boundedXi = clamp(xi, -0.9, 0.95);
    return gpdNegativeLogLikelihood(boundedXi, beta, filtered);
  };
  const { xi, beta } = nelderMead(objective, initialXi, initialBeta);
  if (Math.abs(xi) < xiEps) {
    const sum = filtered.reduce((acc, value) => acc + value, 0);
    const mean = sum / filtered.length;
    return { xi: 0, beta: Math.max(mean, 1e-9) };
  }
  if (!Number.isFinite(xi) || !Number.isFinite(beta) || beta <= 0) {
    throw new Error('Invalid MLE parameters');
  }
  return { xi, beta };
}

function fitGpdByPwm(exceedances: readonly number[]): { xi: number; beta: number } | undefined {
  if (exceedances.length < 2) {
    return undefined;
  }
  const sorted = [...exceedances].sort((a, b) => a - b);
  const n = sorted.length;
  if (n <= 1) {
    return undefined;
  }
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i += 1) {
    const y = sorted[i];
    b0 += y;
    if (n > 1) {
      b1 += ((n - (i + 1)) / (n - 1)) * y;
    }
  }
  b0 /= n;
  if (n > 1) {
    b1 /= n;
  }
  if (!Number.isFinite(b0) || !Number.isFinite(b1)) {
    return undefined;
  }
  const denominator = b0 - 2 * b1;
  if (Math.abs(denominator) < 1e-12) {
    return undefined;
  }
  const rawXi = (2 * b1 - b0) / denominator;
  const xi = clamp(rawXi, -0.9, 0.95);
  const beta = Math.max((2 * b0 * b1) / denominator, 1e-9);
  if (!Number.isFinite(beta) || beta <= 0) {
    return undefined;
  }
  return { xi, beta };
}

function fitGpdByMoments(exceedances: readonly number[]): { xi: number; beta: number } | undefined {
  if (exceedances.length < 2) {
    return undefined;
  }
  const moments = createRunningMoments();
  let running = moments;
  for (const value of exceedances) {
    running = updateRunningMoments(running, value);
  }
  const mean = running.mean;
  if (!Number.isFinite(mean) || mean <= 0) {
    return undefined;
  }
  const variance = running.count >= 2 ? running.m2 / (running.count - 1) : 0;
  if (!Number.isFinite(variance) || variance <= 0) {
    return undefined;
  }
  const ratio = (mean * mean) / variance;
  const rawXi = 0.5 * (1 - ratio);
  const xi = clamp(rawXi, -0.9, 0.95);
  const beta = Math.max(mean * (1 - xi), 1e-9);
  if (!Number.isFinite(beta) || beta <= 0) {
    return undefined;
  }
  return { xi, beta };
}

function fitGpdWithFallbacks(
  exceedances: readonly number[],
  xiEps: number,
  minTailCount: number
): { xi: number; beta: number; estimator: SpotEstimatorType; warnings: string[] } {
  const warnings: string[] = [];
  const usable = exceedances.filter((value) => Number.isFinite(value) && value >= 0);
  if (usable.length === 0) {
    return { xi: 0, beta: 1e-6, estimator: 'quantile', warnings: ['no_exceedances'] };
  }
  if (usable.length < minTailCount) {
    warnings.push('insufficient_tail_samples');
  }
  try {
    const mle = fitGpdMle(usable, xiEps);
    return { xi: mle.xi, beta: mle.beta, estimator: 'mle', warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`mle_failed:${message}`);
  }
  const pwm = fitGpdByPwm(usable);
  if (pwm) {
    warnings.push('pwm_used');
    return { xi: pwm.xi, beta: pwm.beta, estimator: 'pwm', warnings };
  }
  warnings.push('pwm_failed');
  const mom = fitGpdByMoments(usable);
  if (mom) {
    warnings.push('mom_used');
    return { xi: mom.xi, beta: mom.beta, estimator: 'mom', warnings };
  }
  warnings.push('mom_failed');
  const sum = usable.reduce((acc, value) => acc + value, 0);
  const mean = sum / usable.length;
  return {
    xi: 0,
    beta: Math.max(mean, 1e-6),
    estimator: 'quantile',
    warnings: [...warnings, 'fallback_quantile']
  };
}

function computeStabilityScore(candidate: SpotCandidate, previous?: SpotCandidate): number {
  const meanResidualComponent = Math.abs(candidate.meanResidual);
  const estimatorPenalty = candidate.estimator === 'mle' ? 0 : 1;
  if (!previous) {
    const xiComponent = Math.abs(candidate.xi);
    const betaComponent = Math.abs(candidate.beta);
    return meanResidualComponent + xiComponent + betaComponent + estimatorPenalty;
  }
  const xiComponent = Math.abs(candidate.xi - previous.xi);
  const betaDenominator = Math.abs(candidate.beta) + Math.abs(previous.beta) + 1e-9;
  const betaComponent = Math.abs(candidate.beta - previous.beta) / betaDenominator;
  return meanResidualComponent + xiComponent + betaComponent + estimatorPenalty;
}

function selectKneedleIndex(values: readonly number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const normalized = maxValue === minValue ? values.map(() => 1) : values.map((value) => (maxValue - value) / (maxValue - minValue));
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < normalized.length; i += 1) {
    const x = normalized.length === 1 ? 0 : i / (normalized.length - 1);
    const score = normalized[i] - x;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestScore <= 0) {
    let minVal = Number.POSITIVE_INFINITY;
    let minIdx = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] < minVal) {
        minVal = values[i];
        minIdx = i;
      }
    }
    return minIdx;
  }
  return bestIndex;
}

export function calibrateSpot(
  samples: readonly SpotSample[],
  candidateQuantiles: readonly number[],
  options: SpotCalibrateOptions
): SpotCalibrateResult {
  if (samples.length === 0) {
    throw new Error('No samples available for SPOT calibration');
  }
  const sortedValues = [...samples].map((sample) => sample.value).sort((a, b) => a - b);
  const uniqueCandidates = Array.from(new Set(candidateQuantiles.filter((value) => value > 0 && value < 1))).sort(
    (a, b) => a - b
  );
  if (uniqueCandidates.length === 0) {
    throw new Error('No valid candidate quantiles for SPOT calibration');
  }
  const candidates: SpotCandidate[] = [];
  let previousCandidate: SpotCandidate | undefined;
  for (const quantile of uniqueCandidates) {
    let threshold = quantileSorted(sortedValues, quantile);
    let exceedances: SpotSample[] = samples.filter((sample) => sample.value > threshold);
    if (exceedances.length < options.minTailCount && sortedValues.length >= options.minTailCount) {
      const fallbackIndex = Math.max(sortedValues.length - options.minTailCount, 0);
      const fallbackThreshold = sortedValues[fallbackIndex];
      if (fallbackThreshold < threshold) {
        threshold = fallbackThreshold;
      }
      exceedances = samples.filter((sample) => sample.value > threshold);
      if (exceedances.length < options.minTailCount) {
        const epsilon = Math.abs(threshold) * 1e-6 + 1e-9;
        threshold -= epsilon;
        exceedances = samples.filter((sample) => sample.value > threshold);
      }
    }
    const residuals = exceedances.map((sample) => sample.value - threshold).filter((value) => value >= 0);
    const residualMean = residuals.length > 0 ? residuals.reduce((acc, value) => acc + value, 0) / residuals.length : 0;
    const fit = residuals.length > 0
      ? fitGpdWithFallbacks(residuals, options.xiEps, options.minTailCount)
      : { xi: 0, beta: Math.max(residualMean, 1e-6), estimator: 'quantile' as SpotEstimatorType, warnings: ['no_exceedances'] };
    const candidateWarnings: string[] = [];
    if (exceedances.length < options.minTailCount) {
      candidateWarnings.push('exceedances_below_min_tail');
    }
    if (residuals.length < options.minTailCount) {
      candidateWarnings.push('residuals_below_min_tail');
    }
    candidateWarnings.push(...fit.warnings);
    const declusterInput = exceedances.map((sample) => ({ index: sample.index, value: sample.value, payload: sample }));
    const declustered = declusterExceedances(declusterInput, { minSeparation: options.declusterR });
    const clusterCount = declustered.length;
    const theta = clusterCount > 0 ? Math.max(clusterCount / Math.max(exceedances.length, 1), 1e-6) : 1;
    const pRef = clusterCount > 0 ? clusterCount / samples.length : 0;
    const qStar = Math.min(options.q / Math.max(theta, 1e-6), 1);
    const baseCandidate: SpotCandidate = {
      quantile,
      threshold,
      xi: fit.xi,
      beta: fit.beta,
      theta,
      pRef,
      calibrationSize: samples.length,
      meanResidual: residualMean,
      qStar,
      stability: 0,
      estimator: fit.estimator,
      warnings: candidateWarnings
    };
    const stability = computeStabilityScore(baseCandidate, previousCandidate);
    const candidate: SpotCandidate = { ...baseCandidate, stability };
    candidates.push(candidate);
    previousCandidate = candidate;
  }
  if (candidates.length === 0) {
    const fallbackDiagnostics: SpotCalibrationDiagnostics = {
      estimator: 'quantile',
      warnings: ['no_candidates'],
      fallbackUsed: true
    };
    return {
      quantile: uniqueCandidates[uniqueCandidates.length - 1] ?? 0.9,
      threshold: sortedValues[sortedValues.length - 1],
      xi: 0,
      beta: 1e-6,
      theta: 1,
      pRef: 0,
      calibrationSize: samples.length,
      meanResidual: 0,
      qStar: Math.min(options.q, 1),
      diagnostics: fallbackDiagnostics
    };
  }
  const bestIndex = selectKneedleIndex(candidates.map((candidate) => candidate.stability));
  const bestCandidate = candidates[Math.min(Math.max(bestIndex, 0), candidates.length - 1)];
  const uniqueWarnings = Array.from(new Set(bestCandidate.warnings));
  return {
    quantile: bestCandidate.quantile,
    threshold: bestCandidate.threshold,
    xi: bestCandidate.xi,
    beta: bestCandidate.beta,
    theta: bestCandidate.theta,
    pRef: bestCandidate.pRef,
    calibrationSize: bestCandidate.calibrationSize,
    meanResidual: bestCandidate.meanResidual,
    qStar: bestCandidate.qStar,
    diagnostics: {
      estimator: bestCandidate.estimator,
      warnings: uniqueWarnings,
      fallbackUsed: bestCandidate.estimator !== 'mle'
    }
  };
}

export interface SpotRecalibrationOptions {
  readonly minTailCount: number;
  readonly xiEps: number;
  readonly declusterR: number;
  readonly q: number;
}

export function recalibrateSpotParameters(
  current: SpotCalibrateResult,
  newSamples: readonly SpotSample[],
  candidateQuantiles: readonly number[],
  options: SpotRecalibrationOptions
): SpotCalibrateResult {
  if (newSamples.length === 0) {
    const existingDiagnostics = current.diagnostics ?? {
      estimator: 'quantile',
      warnings: [],
      fallbackUsed: true
    };
    return {
      ...current,
      diagnostics: {
        estimator: existingDiagnostics.estimator,
        warnings: [...existingDiagnostics.warnings, 'no_new_samples'],
        fallbackUsed: true,
        usedPrevious: true
      }
    };
  }
  try {
    const outcome = calibrateSpot(newSamples, candidateQuantiles, options);
    const diagnostics = outcome.diagnostics ?? {
      estimator: 'mle',
      warnings: [],
      fallbackUsed: false
    };
    return {
      ...outcome,
      diagnostics: {
        ...diagnostics,
        usedPrevious: false
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existingDiagnostics = current.diagnostics ?? {
      estimator: 'quantile',
      warnings: [],
      fallbackUsed: true
    };
    return {
      ...current,
      diagnostics: {
        estimator: existingDiagnostics.estimator,
        warnings: [...existingDiagnostics.warnings, message],
        fallbackUsed: true,
        usedPrevious: true,
        error: message
      }
    };
  }
}
