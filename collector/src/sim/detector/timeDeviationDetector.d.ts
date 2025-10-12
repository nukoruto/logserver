import type { SimulationEvent } from '../../services/simulationService';

export interface TimeDeviationOptions extends Record<string, unknown> {
  method?: 'quantile' | 'fixed' | 'spot' | string;
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
