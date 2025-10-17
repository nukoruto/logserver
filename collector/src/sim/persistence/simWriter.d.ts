import type { SimulationEvent } from '../../services/simulationService';

export type FeatureResolver = (
  event: SimulationEvent,
  index: number,
  events: SimulationEvent[],
  fallback: number | string | null
) => number | string | null;

export interface FeatureOverrides {
  dt_sec?: FeatureResolver;
  log_dt?: FeatureResolver;
  z?: FeatureResolver;
  z_clipped?: FeatureResolver;
  time_label?: FeatureResolver;
  z_robust?: FeatureResolver;
  z_hourly?: FeatureResolver;
  log_burst_delta?: FeatureResolver;
  log_burst_flag?: FeatureResolver;
  [key: string]: FeatureResolver | undefined;
}

export interface FeatureClipBoundsInput {
  min?: number;
  max?: number;
  lower?: number;
  upper?: number;
}

export interface FeatureComputationOptions {
  windowSize?: number;
  clipBounds?: FeatureClipBoundsInput;
  quantiles?: number[];
  logBurstThreshold?: number;
}

export interface NormalizedFeatureComputationOptions {
  windowSize: number;
  clipBounds: { min: number; max: number };
  quantiles: number[];
  quantileLabels: string[];
  logBurstThreshold: number;
}

export interface PersistSimulationInput extends Record<string, unknown> {
  events: readonly SimulationEvent[];
  scenarioId?: string;
  seed?: string | null;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  manifestFileName?: string;
  parameters?: Record<string, unknown>;
  sessionIds?: readonly string[];
  featureOverrides?: FeatureOverrides;
  featureOptions?: FeatureComputationOptions | NormalizedFeatureComputationOptions;
  manifest?: Record<string, unknown>;
  transitionTableVersion?: string | null;
  extraMetadata?: Record<string, unknown>;
}

export interface PersistSimulationResult {
  csvPath: string;
  manifestPath: string;
  runId: string;
  events: SimulationEvent[];
  manifest: Record<string, unknown>;
  hash: string;
}

export function persistSimulationRun(input: PersistSimulationInput): Promise<PersistSimulationResult>;
export function summarizeDeltas(events: readonly SimulationEvent[]): Record<string, unknown>;
export function buildAnomalySummary(events: readonly SimulationEvent[]): Record<string, number>;
export type AugmentedSimulationEvent = SimulationEvent & {
  dt_sec: number | null;
  log_dt: number | null;
  z: number | null;
  z_clipped: number | null;
  time_label: string | null;
  z_robust: number | null;
  z_hourly: number | null;
  log_burst_delta: number | null;
  log_burst_flag: number | null;
};

export function normalizeFeatureOptions(options?: FeatureComputationOptions | NormalizedFeatureComputationOptions): NormalizedFeatureComputationOptions;
export function augmentRows<T extends SimulationEvent>(
  rows: readonly T[],
  extras?: FeatureOverrides,
  featureOptionsInput?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): Array<T & AugmentedSimulationEvent>;
export function formatCsvAugmented(
  event: AugmentedSimulationEvent,
  featureOptionsInput?: FeatureComputationOptions | NormalizedFeatureComputationOptions,
): string;

declare const simWriter: {
  persistSimulationRun: typeof persistSimulationRun;
  summarizeDeltas: typeof summarizeDeltas;
  buildAnomalySummary: typeof buildAnomalySummary;
  augmentRows: typeof augmentRows;
  formatCsvAugmented: typeof formatCsvAugmented;
};

export { augmentRows, buildAnomalySummary, formatCsvAugmented, normalizeFeatureOptions, persistSimulationRun, summarizeDeltas };
export default simWriter;
