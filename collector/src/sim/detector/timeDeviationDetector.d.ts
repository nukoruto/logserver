import type { SimulationEvent } from '../../services/simulationService';

export interface SpotCalibrationMetadata {
  readonly method: 'spot';
  readonly sampleCount: number;
  readonly tailCount: number;
  readonly u: number;
  readonly xi: number;
  readonly beta: number;
  readonly pRef: number;
  readonly qStar: number;
  readonly tauT: number;
  readonly meanExcess: number;
}

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  spotTailFraction?: number;
  spotTargetProbability?: number;
  spotMinTailCount?: number;
  spotXiEpsilon?: number;
  spotMetadata?: SpotCalibrationMetadata | null;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  timeDeviationSpotUSeconds?: number;
  timeDeviationSpotXi?: number;
  timeDeviationSpotBeta?: number;
  timeDeviationSpotPRef?: number;
  timeDeviationSpotQStar?: number;
  timeDeviationSpotTauTSeconds?: number;
  timeDeviationSpotTailCount?: number;
  timeDeviationSpotSampleCount?: number;
}

export function detectTimeDeviation(
  sequence: readonly SimulationEvent[],
  options?: TimeDeviationOptions
): TimeDeviationEvent[];

export function extractDeltaSeries(sequence: readonly SimulationEvent[]): number[];
export function resolveThreshold(values: readonly number[], options: TimeDeviationOptions): number;

declare const timeDeviationDetector: {
  detectTimeDeviation: typeof detectTimeDeviation;
  extractDeltaSeries: typeof extractDeltaSeries;
  resolveThreshold: typeof resolveThreshold;
};

export { detectTimeDeviation, extractDeltaSeries, resolveThreshold };
export default timeDeviationDetector;
