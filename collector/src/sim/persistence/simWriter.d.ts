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
  z_robust?: FeatureResolver;
  z_robust_clipped?: FeatureResolver;
  z_hourly?: FeatureResolver;
  z_hourly_clipped?: FeatureResolver;
  time_label?: FeatureResolver;
  log_burst_mean?: FeatureResolver;
  log_burst_std?: FeatureResolver;
  log_burst_z?: FeatureResolver;
  log_burst_z_clipped?: FeatureResolver;
  [key: string]: FeatureResolver | undefined;
}

export interface PersistSimulationInput extends Record<string, unknown> {
  events: readonly SimulationEvent[];
  scenarioId?: string;
  seed?: string | null;
  runId?: string | null;
  outputDir?: string;
  csvFileName?: string;
  featureCsvFileName?: string;
  manifestFileName?: string;
  metaFileName?: string;
  parameters?: Record<string, unknown>;
  sessionIds?: readonly string[];
  featureOverrides?: FeatureOverrides;
  manifest?: Record<string, unknown>;
  transitionTableVersion?: string | null;
  extraMetadata?: Record<string, unknown>;
  includeFeaturesCsv?: boolean;
}

export interface PersistSimulationResult {
  csvPath: string;
  featuresCsvPath: string | null;
  manifestPath: string;
  metaPath: string | null;
  runId: string;
  events: SimulationEvent[];
  manifest: Record<string, unknown>;
  csvHash: string;
  featuresCsvHash: string | null;
  featureHeader?: string[];
}

export function persistSimulationRun(input: PersistSimulationInput): Promise<PersistSimulationResult>;
export function summarizeDeltas(events: readonly SimulationEvent[]): Record<string, unknown>;
export function buildAnomalySummary(events: readonly SimulationEvent[]): Record<string, number>;
export type AugmentedSimulationEvent = SimulationEvent & {
  dt_sec: number | null;
  log_dt: number | null;
  z: number | null;
  z_clipped: number | null;
  z_robust: number | null;
  z_robust_clipped: number | null;
  z_hourly: number | null;
  z_hourly_clipped: number | null;
  time_label: string | null;
  log_burst_mean: number | null;
  log_burst_std: number | null;
  log_burst_z: number | null;
  log_burst_z_clipped: number | null;
} & Record<string, unknown>;

export interface AugmentComputationOptions {
  epsilonT?: number;
  measurementEpsilon?: number;
  windowSize?: number;
  quantiles?: readonly number[];
  clipBounds?: Partial<Record<'z' | 'z_robust' | 'z_hourly' | 'log_burst_z', ClipBoundInput>>;
}

export type ClipBoundInput =
  | { min?: number; max?: number }
  | readonly [number, number]
  | number[]
  | number
  | null
  | undefined;

export interface FeatureAugmenterClipBounds {
  z: { min: number; max: number };
  z_robust: { min: number; max: number };
  z_hourly: { min: number; max: number };
  log_burst_z: { min: number; max: number };
}

export interface FeatureAugmenterOptions {
  windowSize: number;
  quantiles: number[];
  clipBounds: FeatureAugmenterClipBounds;
}

export function augmentRows<T extends SimulationEvent>(
  rows: readonly T[],
  extras?: FeatureOverrides,
  options?: AugmentComputationOptions,
): Array<T & AugmentedSimulationEvent>;
export function formatCsvAugmented(
  event: AugmentedSimulationEvent,
  featureColumns: readonly string[],
): string;
export function validateContractColumns(columns: readonly unknown[]): void;

export const DEFAULT_FEATURE_AUGMENTER: FeatureAugmenterOptions;
export function resolveFeatureAugmenterOptions(
  input?: Partial<FeatureAugmenterOptions> | Record<string, unknown>,
): FeatureAugmenterOptions;
export function cloneFeatureAugmenterOptions(options: FeatureAugmenterOptions): FeatureAugmenterOptions;

declare const simWriter: {
  persistSimulationRun: typeof persistSimulationRun;
  summarizeDeltas: typeof summarizeDeltas;
  buildAnomalySummary: typeof buildAnomalySummary;
  augmentRows: typeof augmentRows;
  formatCsvAugmented: typeof formatCsvAugmented;
  validateContractColumns: typeof validateContractColumns;
};

export {
  augmentRows,
  buildAnomalySummary,
  formatCsvAugmented,
  persistSimulationRun,
  summarizeDeltas,
  validateContractColumns,
};
export default simWriter;
