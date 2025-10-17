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
  [key: string]: FeatureResolver | undefined;
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
};

export interface AugmentComputationOptions {
  epsilonT?: number;
  measurementEpsilon?: number;
}

export function augmentRows<T extends SimulationEvent>(
  rows: readonly T[],
  extras?: FeatureOverrides,
  options?: AugmentComputationOptions,
): Array<T & AugmentedSimulationEvent>;
export function formatCsvAugmented(event: AugmentedSimulationEvent): string;

declare const simWriter: {
  persistSimulationRun: typeof persistSimulationRun;
  summarizeDeltas: typeof summarizeDeltas;
  buildAnomalySummary: typeof buildAnomalySummary;
  augmentRows: typeof augmentRows;
  formatCsvAugmented: typeof formatCsvAugmented;
};

export { augmentRows, buildAnomalySummary, formatCsvAugmented, persistSimulationRun, summarizeDeltas };
export default simWriter;
