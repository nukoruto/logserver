import type { SimulationEvent } from '../../services/simulationService';

export type ThresholdTier = 'group' | 'user' | 'global';

export interface TimeDeviationThresholdSummary {
  tier_usage: Record<ThresholdTier, number>;
  sample_counts: {
    global: number;
    per_user: Record<string, number>;
    per_group: Record<string, number>;
  };
}

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
  quantile?: number;
  minSamples?: number;
  fallbackThresholdSeconds?: number | string | null;
  thresholdSeconds?: number | string | null;
  baselineSequence?: readonly SimulationEvent[];
  statsCache?: TimeDeviationThresholdCache;
}

export interface TimeDeviationEvent extends SimulationEvent {
  timeDeviationObservedDeltaSeconds?: number;
  timeDeviationThresholdSeconds?: number;
  timeDeviationScore?: number;
  timeDeviationFlag?: boolean;
  timeDeviationThresholdTier?: ThresholdTier;
  timeDeviationSampleCount?: number;
}

export class TimeDeviationThresholdCache {
  record(uid: string | null, opCategory: string | null, deltaSeconds: number): void;
  seedGlobal(values: readonly number[]): void;
  summary(): TimeDeviationThresholdSummary;
}

export function createThresholdCache(): TimeDeviationThresholdCache;

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
  createThresholdCache: typeof createThresholdCache;
};

export { detectTimeDeviation, extractDeltaSeries, resolveThreshold, createThresholdCache };
export default timeDeviationDetector;
