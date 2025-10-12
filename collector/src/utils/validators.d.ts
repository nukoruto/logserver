import type { EventPayload } from '../storage/eventRepository';

export function normalizeEventPayload(payload: unknown): EventPayload;
export function normalizeBatchPayload(payloads: readonly unknown[]): EventPayload[];

declare const validators: {
  normalizeEventPayload: typeof normalizeEventPayload;
  normalizeBatchPayload: typeof normalizeBatchPayload;
};

export { validators };
export default validators;
