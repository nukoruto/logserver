import type { SimulationEvent } from '../../services/simulationService';

export type StrategyConfig = Record<string, unknown>;

export type TimeDeviationMode = 'auto' | 'propagate' | 'local';

export interface SessionContext {
  sessionId?: string | null;
  userId?: string | null;
  uid?: string | null;
}

export interface AnomalyInjectionOptions extends Record<string, unknown> {
  anomalyRate?: number;
  anomalyCount?: number | null;
  interval?: number | null;
  minAnomalies?: number;
  maxAnomalies?: number | null;
  seed?: number | string | null;
  markField?: string;
  strategies?: Record<string, StrategyConfig> | Iterable<string> | null;
  session?: SessionContext | null;
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
