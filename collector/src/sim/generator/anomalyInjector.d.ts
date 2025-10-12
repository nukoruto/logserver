import type { SimulationEvent } from '../../services/simulationService';

export type StrategyConfig = Record<string, unknown>;

export interface AnomalyInjectionOptions extends Record<string, unknown> {
  anomalyRate?: number;
  anomalyCount?: number | null;
  interval?: number | null;
  minAnomalies?: number;
  maxAnomalies?: number | null;
  seed?: number | string | null;
  markField?: string;
  strategies?: Record<string, StrategyConfig> | Iterable<string> | null;
}

export function injectAnomaly(
  sequence: readonly SimulationEvent[],
  options?: AnomalyInjectionOptions
): SimulationEvent[];

declare const anomalyInjector: {
  injectAnomaly: typeof injectAnomaly;
};

export { injectAnomaly };
export default anomalyInjector;
