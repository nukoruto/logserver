import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | 'otsu' | 'knee' | string;
  quantile?: number;
  quantileUpper?: number;
  quantileLower?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  fallbackLowerThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  lowerThresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  voteWindow?: number | string | null;
  voteThreshold?: number | string | null;
  hysteresisHold?: number | string | null;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationThresholdLowerSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  timeDeviationRawFlag?: boolean;
  tau_hi?: number;
  tau_lo?: number;
  s_Q?: number;
  timeDeviationCalibrationUSeconds?: number | null;
  timeDeviationCalibrationXi?: number | null;
  timeDeviationCalibrationBeta?: number | null;
  timeDeviationCalibrationPRef?: number | null;
  timeDeviationCalibrationTauTSeconds?: number | null;
}

export interface TimeDeviationHistogramDiagnostics {
  binEdgesSeconds: number[];
  binEdgesLogSeconds: number[];
  counts: number[];
  total: number;
  method: 'log';
}

export interface TimeDeviationDiagnostics {
  method: string;
  baselineCount: number;
  baselineMeanSeconds: number | null;
  baselineStdSeconds: number | null;
  baselineMinSeconds: number | null;
  baselineMaxSeconds: number | null;
  thresholdSeconds: number;
  thresholdLowerSeconds: number;
  fallbackApplied: boolean;
  quantile?: number | null;
  otsu?: {
    thresholdSeconds: number | null;
    logThreshold: number | null;
    betweenClassVariance: number | null;
    histogram: TimeDeviationHistogramDiagnostics | null;
  } | null;
  knee?: {
    thresholdSeconds: number | null;
    logThreshold: number | null;
    sampleIndex: number | null;
    normalizedIndex: number | null;
    distance: number | null;
  } | null;
  groupThresholds?: Record<string, {
    tauHiSeconds: number;
    tauLoSeconds: number;
    sampleCount: number;
    fallbackToGlobal: boolean;
  }>;
  spot?: {
    uSeconds: number | null;
    xi: number | null;
    beta: number | null;
    pRef: number | null;
    qStar: number | null;
    tauTSeconds: number | null;
    exceedanceCount: number;
    sampleCount: number;
  } | null;
  postProcessing?: {
    voteWindow: number;
    voteThreshold: number;
    hysteresisHold: number;
  };
}

export interface TimeDeviationDetectionResult {
  events: TimeDeviationEvent[];
  thresholdSeconds: number;
  thresholdLowerSeconds: number;
  diagnostics: TimeDeviationDiagnostics;
}

export function detectTimeDeviation(
  sequence: readonly SimulationEvent[],
  options?: TimeDeviationOptions
): TimeDeviationDetectionResult;

export function extractDeltaSeries(sequence: readonly SimulationEvent[]): number[];
export function resolveThreshold(values: readonly number[], options: TimeDeviationOptions): number;

export const DEFAULT_VOTE_WINDOW: number;
export const DEFAULT_VOTE_THRESHOLD: number;
export const DEFAULT_HYSTERESIS_HOLD: number;

declare const timeDeviationDetector: {
  detectTimeDeviation: typeof detectTimeDeviation;
  extractDeltaSeries: typeof extractDeltaSeries;
  resolveThreshold: typeof resolveThreshold;
};

export { detectTimeDeviation, extractDeltaSeries, resolveThreshold };
export default timeDeviationDetector;
