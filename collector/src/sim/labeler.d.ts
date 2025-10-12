import type { SimulationEvent, SimulationEventMetadata } from '../services/simulationService';

export type LabeledEvent = SimulationEvent & {
  anomaly: boolean;
  anomalyLabel: number;
  anomaly_type: string;
  metadata: SimulationEventMetadata;
};

export function labelSequence(sequence: readonly SimulationEvent[]): LabeledEvent[];

declare const labeler: {
  labelSequence: typeof labelSequence;
};

export { labelSequence };
export default labeler;
