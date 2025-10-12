import type { SimulationEvent } from '../../services/simulationService';

export interface ProtocolValidatorOptions extends Record<string, unknown> {}

export interface ProtocolAnnotatedEvent extends SimulationEvent {
  protocolViolationFlag?: boolean;
  protocolViolationReasons?: string[];
  protocolViolationState?: Record<string, unknown>;
}

export function validateProtocol(
  sequence: readonly SimulationEvent[],
  options?: ProtocolValidatorOptions
): ProtocolAnnotatedEvent[];

declare const protocolValidator: {
  validateProtocol: typeof validateProtocol;
};

export { validateProtocol };
export default protocolValidator;
