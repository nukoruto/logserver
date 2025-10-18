import { createReadStream, createWriteStream } from 'node:fs';
import { parse, format } from 'fast-csv';
import { readAnomalyStats, readAnomalyMeta } from './io.js';
import { SpotAuditLogger } from './audit.js';
import { toFiniteNumber } from './utils.js';
import {
  recalibrateSpotParameters,
  type SpotCalibrateResult,
  type SpotSample,
  type SpotCalibrationDiagnostics,
  type SpotEstimatorType,
  spotThreshold,
  pValueRef,
  gpSurvival
} from './spot.js';
import type { QuantileGroupEntry, SpotGroupEntry } from './schema.js';

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

interface EmpiricalCdfPoint {
  readonly value: number;
  readonly p: number;
}

type QuantileCdfEntry = QuantileGroupEntry['cdf'][number];

function buildEmpiricalCdfPoints(entries: readonly QuantileCdfEntry[]): EmpiricalCdfPoint[] {
  if (entries.length === 0) {
    return [
      {
        value: 0,
        p: 0
      },
      {
        value: 0,
        p: 1
      }
    ];
  }
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const epsilonLower = Math.max(Math.abs(first.value) * 1e-6, 1e-9);
  const epsilonUpper = Math.max(Math.abs(last.value) * 1e-6, 1e-9);
  const points: EmpiricalCdfPoint[] = [];
  points.push({ value: first.value - epsilonLower, p: 0 });
  for (const entry of sorted) {
    points.push({ value: entry.value, p: clampProbability(entry.p) });
  }
  points.push({ value: last.value + epsilonUpper, p: 1 });
  return points;
}

function evaluateEmpiricalCdf(points: readonly EmpiricalCdfPoint[], value: number): number {
  if (points.length === 0) {
    return 0;
  }
  if (value <= points[0].value) {
    return clampProbability(points[0].p);
  }
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (value <= curr.value) {
      if (curr.value === prev.value) {
        return clampProbability(curr.p);
      }
      const ratio = (value - prev.value) / (curr.value - prev.value);
      const interpolated = prev.p + ratio * (curr.p - prev.p);
      return clampProbability(interpolated);
    }
  }
  return clampProbability(points[points.length - 1].p);
}

export interface ScoreOptions {
  readonly input: string;
  readonly output: string;
  readonly statsPath: string;
  readonly metaPath: string;
  readonly auditPath: string;
}

export interface ScoreSummary {
  readonly processedRows: number;
  readonly flaggedRows: number;
}

interface SpotRuntimeParams {
  domain: 'log_dt' | 'z_deseas';
  u: number;
  xi: number;
  beta: number;
  pRef: number;
  theta: number;
  qStar: number;
  p0: number;
  calibrationSize: number;
  meanResidual: number;
}

interface SpotRuntimeState {
  params: SpotRuntimeParams;
  estimator: SpotEstimatorType;
  warnings: string[];
  diagnostics?: SpotCalibrationDiagnostics;
  lastTau: number;
  window: number[];
  windowSum: number;
  alarmLatched: boolean;
  processedSinceReestimate: number;
  exceedSinceReestimate: number;
  exceedSamples: SpotSample[];
}

function computeStreamingTau(params: SpotRuntimeParams, lastTau: number): number {
  const tauCandidate = spotThreshold(params.u, params.xi, params.beta, params.pRef, params.qStar);
  let nextTau = Number.isFinite(tauCandidate) ? tauCandidate : params.u;
  nextTau = Math.max(nextTau, params.u);
  if (params.xi < 0) {
    const upperBound = params.u - params.beta / params.xi;
    const clippedCandidate = Math.min(nextTau, upperBound);
    const clippedLast = Math.min(lastTau, upperBound);
    return Math.max(clippedCandidate, clippedLast);
  }
  return Math.max(nextTau, lastTau);
}

function createRuntimeState(entry: SpotGroupEntry): SpotRuntimeState {
  const params: SpotRuntimeParams = {
    domain: entry.domain,
    u: entry.u,
    xi: entry.xi,
    beta: entry.beta,
    pRef: entry.p_ref,
    theta: entry.theta,
    qStar: entry.q_star,
    p0: entry.p0,
    calibrationSize: entry.calib_N,
    meanResidual: 0
  };
  const initialTau = computeStreamingTau(params, params.u);
  const estimator = entry.estimator ?? 'mle';
  const warnings = entry.warnings ? [...entry.warnings] : [];
  const diagnostics: SpotCalibrationDiagnostics = {
    estimator,
    warnings,
    fallbackUsed: estimator !== 'mle' || warnings.length > 0,
    usedPrevious: false
  };
  return {
    params,
    estimator,
    warnings,
    diagnostics,
    lastTau: initialTau,
    window: [],
    windowSum: 0,
    alarmLatched: false,
    processedSinceReestimate: 0,
    exceedSinceReestimate: 0,
    exceedSamples: []
  };
}

function cloneParams(params: SpotRuntimeParams): SpotRuntimeParams {
  return { ...params };
}

function toCalibrateResult(state: SpotRuntimeState): SpotCalibrateResult {
  const diagnostics = state.diagnostics ?? {
    estimator: state.estimator,
    warnings: state.warnings,
    fallbackUsed: state.estimator !== 'mle'
  };
  const params = state.params;
  return {
    quantile: params.p0,
    threshold: params.u,
    xi: params.xi,
    beta: params.beta,
    theta: params.theta,
    pRef: params.pRef,
    calibrationSize: params.calibrationSize,
    meanResidual: params.meanResidual,
    qStar: params.qStar,
    diagnostics
  };
}

function applyCalibrateResult(state: SpotRuntimeState, result: SpotCalibrateResult): void {
  state.params = {
    ...state.params,
    u: result.threshold,
    xi: result.xi,
    beta: result.beta,
    theta: result.theta,
    pRef: result.pRef,
    qStar: result.qStar,
    p0: result.quantile,
    calibrationSize: result.calibrationSize,
    meanResidual: result.meanResidual
  };
  const diagnostics = result.diagnostics ?? {
    estimator: state.estimator,
    warnings: state.warnings,
    fallbackUsed: state.estimator !== 'mle'
  };
  state.estimator = diagnostics.estimator;
  state.warnings = [...diagnostics.warnings];
  state.diagnostics = diagnostics;
}

export async function scoreStream(options: ScoreOptions): Promise<ScoreSummary> {
  const stats = await readAnomalyStats(options.statsPath);
  const meta = await readAnomalyMeta(options.metaPath);
  const baseColumn = stats.base_column;
  interface QuantileRuntimeEntry {
    readonly entry: QuantileGroupEntry;
    readonly cdfPoints: EmpiricalCdfPoint[];
  }
  const quantileEntries = stats.quantile;
  const quantileMap = new Map<string, QuantileRuntimeEntry>();
  const userFallback = new Map<string, QuantileRuntimeEntry>();
  let globalFallback: QuantileRuntimeEntry | undefined;
  const quantileResolutionCache = new Map<string, QuantileRuntimeEntry>();
  for (const entry of quantileEntries) {
    const runtimeEntry: QuantileRuntimeEntry = {
      entry,
      cdfPoints: buildEmpiricalCdfPoints(entry.cdf)
    };
    if (entry.uid === '__global__' && entry.op_category === '__global__') {
      globalFallback = runtimeEntry;
      continue;
    }
    if (entry.op_category === '__all__') {
      userFallback.set(entry.uid, runtimeEntry);
      continue;
    }
    quantileMap.set(`${entry.uid}||${entry.op_category}`, runtimeEntry);
  }
  if (!globalFallback) {
    throw new Error('Global fallback quantile (*,*) missing in stats');
  }
  const globalQuantile = globalFallback;
  function resolveQuantile(uid: string, opCategory: string): QuantileRuntimeEntry {
    const cacheKey = `${uid}||${opCategory}`;
    const cached = quantileResolutionCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const direct = quantileMap.get(cacheKey);
    if (direct) {
      quantileResolutionCache.set(cacheKey, direct);
      return direct;
    }
    const user = userFallback.get(uid);
    if (user) {
      quantileResolutionCache.set(cacheKey, user);
      return user;
    }
    quantileResolutionCache.set(cacheKey, globalQuantile);
    return globalQuantile;
  }
  const spotEntries = stats.spot;
  const spotMap = new Map<string, typeof spotEntries[number]>();
  const spotUserFallback = new Map<string, typeof spotEntries[number]>();
  let spotGlobal: typeof spotEntries[number] | undefined;
  const spotResolutionCache = new Map<string, typeof spotEntries[number]>();
  for (const entry of spotEntries) {
    if (entry.uid === '__global__' && entry.op_category === '__global__') {
      spotGlobal = entry;
      continue;
    }
    if (entry.op_category === '__all__') {
      spotUserFallback.set(entry.uid, entry);
      continue;
    }
    spotMap.set(`${entry.uid}||${entry.op_category}`, entry);
  }
  if (!spotGlobal) {
    throw new Error('Global SPOT entry missing in stats');
  }
  const globalSpot = spotGlobal;
  function resolveSpot(uid: string, opCategory: string) {
    const cacheKey = `${uid}||${opCategory}`;
    const cached = spotResolutionCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const direct = spotMap.get(cacheKey);
    if (direct) {
      spotResolutionCache.set(cacheKey, direct);
      return direct;
    }
    const user = spotUserFallback.get(uid);
    if (user) {
      spotResolutionCache.set(cacheKey, user);
      return user;
    }
    spotResolutionCache.set(cacheKey, globalSpot);
    return globalSpot;
  }
  const hysteresisH = meta.H;
  if (!(Number.isFinite(hysteresisH) && hysteresisH > 1)) {
    throw new Error('H must be greater than 1');
  }
  const [kVotes, windowSize] = meta.kofn;
  if (!(windowSize >= 1 && kVotes >= 1 && kVotes <= windowSize)) {
    throw new Error('Invalid k-of-n parameters in metadata');
  }
  const xiEps = meta.spot.xi_eps;
  const candidateQuantiles = meta.spot.p0_candidates;
  const spotMinTail = meta.spot.min_tail_count;
  const declusterR = meta.spot.decluster_r;
  const controlQ = meta.q;
  const reestimateEvery = meta.reestimate_every;
  const minExceed = meta.min_exceed;
  const spotStates = new Map<string, SpotRuntimeState>();
  const audit = new SpotAuditLogger(options.auditPath);
  let processed = 0;
  let flagged = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const parser = parse({ headers: true, ignoreEmpty: true, trim: true });
      const formatter = format({ headers: true });
      const output = createWriteStream(options.output, { encoding: 'utf8' });
      formatter.pipe(output).on('error', reject);
      formatter.on('error', reject);
      formatter.on('finish', () => resolve());
      parser.on('error', reject);
      parser.on('data', (row: Record<string, string>) => {
        processed += 1;
        const uid = row.uid;
        const opCategory = row.op_category;
        if (!uid || !opCategory) {
          throw new Error(`Missing uid/op_category at row ${processed}`);
        }
        const value = toFiniteNumber(row[baseColumn], baseColumn);
        const quantile = resolveQuantile(uid, opCategory);
        const tauHi = quantile.entry.tau_hi;
        const tauLo = quantile.entry.tau_lo;
        const cdfValue = evaluateEmpiricalCdf(quantile.cdfPoints, value);
        const pLowerQuantile = clampProbability(cdfValue);
        const pUpperQuantile = clampProbability(1 - cdfValue);
        const pLowerCombined = clampProbability(pLowerQuantile);
        const spotEntry = resolveSpot(uid, opCategory);
        if (!spotEntry) {
          throw new Error(`Missing SPOT parameters for ${uid}/${opCategory}`);
        }
        const stateKey = `${spotEntry.uid}||${spotEntry.op_category}`;
        let state = spotStates.get(stateKey);
        if (!state) {
          state = createRuntimeState(spotEntry);
          spotStates.set(stateKey, state);
        }
        const domainColumn = state.params.domain;
        const domainValue = toFiniteNumber(row[domainColumn], domainColumn);
        const tauDomain = computeStreamingTau(state.params, state.lastTau);
        state.lastTau = tauDomain;
        const tauDelta = Math.max(Math.exp(tauDomain), 1e-12);
        const delta = Math.max(value, 0);
        const sEvt = delta / tauDelta;
        const exceed = sEvt > 1;
        state.window.push(exceed ? 1 : 0);
        state.windowSum += exceed ? 1 : 0;
        if (state.window.length > windowSize) {
          const removed = state.window.shift();
          if (removed) {
            state.windowSum -= removed;
          }
        }
        if (state.alarmLatched) {
          if (sEvt <= 1 / hysteresisH) {
            state.alarmLatched = false;
            state.window = [];
            state.windowSum = 0;
          }
        } else if (state.windowSum >= kVotes) {
          state.alarmLatched = true;
        }
        const spotAlarm = state.alarmLatched;
        const excess = Math.max(domainValue - state.params.u, 0);
        const spotSurvival = gpSurvival(excess, state.params.xi, state.params.beta);
        const pUpperSpot = clampProbability(pValueRef(excess, state.params.xi, state.params.beta, state.params.pRef));
        const score = -Math.log10(Math.max(pUpperSpot, 1e-300));
        const spotTauClassic = state.params.beta / Math.max(1 - state.params.xi, 1e-6);
        const spotThetaClassic = state.params.u + spotTauClassic;
        const spotPref = domainValue >= state.params.u ? 'upper' : 'lower';
        const quantileUpperBreach = value > tauHi;
        const quantileLowerBreach = value < tauLo;
        let alarmReason: '' | 'quantile_upper' | 'quantile_lower' | 'spot_upper' | 'both' = '';
        if (quantileUpperBreach && quantileLowerBreach) {
          alarmReason = 'both';
        } else if (quantileUpperBreach) {
          alarmReason = 'quantile_upper';
        } else if (quantileLowerBreach) {
          alarmReason = 'quantile_lower';
        }
        if (spotAlarm) {
          alarmReason = alarmReason === '' ? 'spot_upper' : 'both';
        }
        const alarmTriggered = spotAlarm;
        if (alarmTriggered) {
          flagged += 1;
        }
        state.processedSinceReestimate += 1;
        if (domainValue > state.params.u) {
          state.exceedSinceReestimate += 1;
          state.exceedSamples.push({ value: domainValue, index: processed });
        }
        const next: Record<string, string> = { ...row };
        next.tau_hi = tauHi.toFixed(6);
        next.tau_lo = tauLo.toFixed(6);
        const safeTauHi = Math.max(tauHi, 1e-9);
        const safeValue = Math.max(Math.abs(value), 1e-9);
        const safeTauLo = Math.max(Math.abs(tauLo), 1e-9);
        let sQ = 1;
        if (quantileUpperBreach) {
          sQ = value / safeTauHi;
        } else if (quantileLowerBreach) {
          sQ = safeTauLo / safeValue;
        }
        next.s_Q = sQ.toFixed(6);
        next.spot_u = state.params.u.toFixed(6);
        next.spot_xi = state.params.xi.toFixed(6);
        next.spot_beta = state.params.beta.toFixed(6);
        next.spot_pref = spotPref;
        next.spot_theta = spotThetaClassic.toFixed(6);
        next.spot_tau_t = tauDelta.toFixed(6);
        next.spot_tau_classic = spotTauClassic.toFixed(6);
        next.s_evt = sEvt.toFixed(6);
        next.p_upper_quantile = pUpperQuantile.toExponential(6);
        next.p_upper_spot = pUpperSpot.toExponential(6);
        next.p_lower = pLowerCombined.toExponential(6);
        next.neglog10_p = score.toFixed(6);
        next.spot_theta_ext = state.params.theta.toFixed(6);
        next.spot_p_ref = state.params.pRef.toExponential(6);
        next.spot_q_star = state.params.qStar.toExponential(6);
        next.spot_estimator = state.estimator;
        next.spot_warnings = state.warnings.join('|');
        next.spot_alarm_kofn = spotAlarm ? '1' : '0';
        next.alarm = alarmTriggered ? '1' : '0';
        next.alarm_reason = alarmReason;
        formatter.write(next);
        audit.write({
          row: processed,
          value,
          threshold: state.params.u,
          tailProbability: pUpperSpot,
          score,
          flagged: alarmTriggered,
          metadata: {
            base_column: baseColumn,
            uid,
            op_category: opCategory,
            tau_hi: tauHi,
            tau_lo: tauLo,
            spot_domain: state.params.domain,
            spot_tau_domain: tauDomain,
            spot_tau: tauDelta,
            spot_alarm_kofn: spotAlarm,
            extremal_index: state.params.theta,
            k_of_n: [kVotes, windowSize],
            alarm_reason: alarmReason,
            p_upper_quantile: pUpperQuantile,
            p_upper_spot: pUpperSpot,
            p_lower: pLowerCombined,
            spot_survival: spotSurvival,
            s_evt: sEvt,
            H: hysteresisH,
            spot_estimator: state.estimator,
            spot_warnings: state.warnings
          }
        });
        let reestimateEvent:
          | {
              previous: SpotRuntimeParams;
              current: SpotRuntimeParams;
              sampleCount: number;
              diagnostics: SpotCalibrationDiagnostics;
            }
          | undefined;
        let reestimateFailure:
          | {
              diagnostics: SpotCalibrationDiagnostics;
              sampleCount: number;
            }
          | undefined;
        const shouldCheckReestimate = reestimateEvery > 0 && state.processedSinceReestimate >= reestimateEvery;
        if (shouldCheckReestimate) {
          if (state.exceedSinceReestimate >= minExceed && state.exceedSamples.length >= spotMinTail) {
            const previousParams = cloneParams(state.params);
            const currentResult = toCalibrateResult(state);
            const recalibrated = recalibrateSpotParameters(currentResult, state.exceedSamples, candidateQuantiles, {
              minTailCount: spotMinTail,
              xiEps,
              declusterR,
              q: controlQ
            });
            const diagnostics = recalibrated.diagnostics ?? {
              estimator: state.estimator,
              warnings: [],
              fallbackUsed: false
            };
            if (diagnostics.usedPrevious) {
              reestimateFailure = { diagnostics, sampleCount: state.exceedSamples.length };
              const combinedWarnings = new Set([...state.warnings, ...diagnostics.warnings]);
              state.warnings = Array.from(combinedWarnings);
              state.diagnostics = {
                estimator: state.estimator,
                warnings: state.warnings,
                fallbackUsed: diagnostics.fallbackUsed,
                usedPrevious: true,
                error: diagnostics.error
              };
            } else {
              applyCalibrateResult(state, recalibrated);
              const updatedTau = computeStreamingTau(state.params, state.lastTau);
              state.lastTau = updatedTau;
              state.window = [];
              state.windowSum = 0;
              state.alarmLatched = false;
              reestimateEvent = {
                previous: previousParams,
                current: cloneParams(state.params),
                sampleCount: state.exceedSamples.length,
                diagnostics
              };
            }
          }
          state.processedSinceReestimate = 0;
          state.exceedSinceReestimate = 0;
          state.exceedSamples = [];
        }
        if (reestimateEvent) {
          const deltaU = reestimateEvent.current.u - reestimateEvent.previous.u;
          const deltaXi = reestimateEvent.current.xi - reestimateEvent.previous.xi;
          const deltaBeta = reestimateEvent.current.beta - reestimateEvent.previous.beta;
          const deltaPref = reestimateEvent.current.pRef - reestimateEvent.previous.pRef;
          const deltaTheta = reestimateEvent.current.theta - reestimateEvent.previous.theta;
          const changed =
            Math.abs(deltaU) > 1e-9 ||
            Math.abs(deltaXi) > 1e-9 ||
            Math.abs(deltaBeta) > 1e-9 ||
            Math.abs(deltaPref) > 1e-9 ||
            Math.abs(deltaTheta) > 1e-9;
          if (changed) {
            audit.write({
              row: processed,
              value,
              threshold: state.params.u,
              tailProbability: pUpperSpot,
              score,
              flagged: alarmTriggered,
              metadata: {
                event: 'reestimate',
                uid,
                op_category: opCategory,
                samples_used: reestimateEvent.sampleCount,
                delta: {
                  u: deltaU,
                  xi: deltaXi,
                  beta: deltaBeta,
                  p_ref: deltaPref,
                  theta: deltaTheta
                },
                new_params: {
                  u: state.params.u,
                  xi: state.params.xi,
                  beta: state.params.beta,
                  p_ref: state.params.pRef,
                  theta: state.params.theta,
                  q_star: state.params.qStar
                },
                diagnostics: {
                  estimator: reestimateEvent.diagnostics.estimator,
                  warnings: reestimateEvent.diagnostics.warnings,
                  fallback_used: reestimateEvent.diagnostics.fallbackUsed
                },
                spot_survival: spotSurvival,
                p_upper_spot: pUpperSpot,
                s_evt: sEvt
              }
            });
          }
        } else if (reestimateFailure) {
          audit.write({
            row: processed,
            value,
            threshold: state.params.u,
            tailProbability: pUpperSpot,
            score,
            flagged: alarmTriggered,
            metadata: {
              event: 'reestimate_failed',
              uid,
              op_category: opCategory,
              samples_used: reestimateFailure.sampleCount,
              estimator: reestimateFailure.diagnostics.estimator,
              warnings: reestimateFailure.diagnostics.warnings,
              error: reestimateFailure.diagnostics.error
            }
          });
        }
      });
      parser.on('end', () => {
        formatter.end();
      });
      createReadStream(options.input).pipe(parser).on('error', reject);
    });
    return { processedRows: processed, flaggedRows: flagged };
  } finally {
    await audit.close();
  }
}
