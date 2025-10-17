import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | 'otsu' | 'knee' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
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
}

export interface TimeDeviationDetectionResult {
  events: TimeDeviationEvent[];
  thresholdSeconds: number;
  diagnostics: TimeDeviationDiagnostics;
}

export function detectTimeDeviation(
  sequence: readonly SimulationEvent[],
  options?: TimeDeviationOptions
): TimeDeviationDetectionResult;

export function extractDeltaSeries(sequence: readonly SimulationEvent[]): number[];
export function resolveThreshold(values: readonly number[], options: TimeDeviationOptions): number;

declare const timeDeviationDetector: {
  detectTimeDeviation: typeof detectTimeDeviation;
  extractDeltaSeries: typeof extractDeltaSeries;
  resolveThreshold: typeof resolveThreshold;
};

export { detectTimeDeviation, extractDeltaSeries, resolveThreshold };
export default timeDeviationDetector;
