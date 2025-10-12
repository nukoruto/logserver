import type { SimulationEvent, SimulationEventMetadata } from '../services/simulationService';

export type LabeledEvent = SimulationEvent & {
  anomaly: boolean;
  anomalyLabel: number;
  anomaly_type: string;
  metadata: SimulationEventMetadata;
};

const MARK_FIELD_CANDIDATES = ['_anomalyType', 'anomalyType', 'anomaly_type'] as const;
const MARK_TYPE_MAP: Record<string, string> = {
  authenticationbypass: 'auth_failure',
  auth_failure: 'auth_failure',
  protocolviolation: 'protocol_violation',
  protocol_violation: 'protocol_violation',
  timedeviation: 'time_deviation',
  time_deviation: 'time_deviation',
};

const AUTH_REASON_CODES = new Set([
  'unauthenticatedoperation',
  'unauthenticatedbeforelogin',
  'logoutwithoutlogin',
  'missinginitiallogin',
  'unauthorizedoperation',
  'invalidcredentials',
  'tokenmismatch',
  'sessionmismatch',
  'invalidsessionidformat',
]);

const AUTH_STATUS_VALUES = new Set(['invalid', 'revoked', 'expired', 'unauthorized', 'forbidden']);

const PRIORITY_ORDER: Record<string, number> = {
  auth_failure: 1,
  protocol_violation: 2,
  time_deviation: 3,
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeLower = (value: unknown): string | null => {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
};

const resolveMarkLabel = (event: SimulationEvent | null | undefined): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  for (const field of MARK_FIELD_CANDIDATES) {
    if (!Object.prototype.hasOwnProperty.call(event, field)) {
      continue;
    }
    const markValue = normalizeLower(event[field]);
    if (!markValue) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MARK_TYPE_MAP, markValue)) {
      return MARK_TYPE_MAP[markValue];
    }
  }
  return null;
};

const collectProtocolReasons = (event: SimulationEvent | null | undefined): string[] => {
  if (!event || typeof event !== 'object') {
    return [];
  }
  const reasons = Array.isArray(event.protocolViolationReasons)
    ? event.protocolViolationReasons
    : [];
  return reasons
    .map((reason) => normalizeLower(reason))
    .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
};

const hasAuthFailureIndicator = (event: SimulationEvent | null | undefined, reasons: readonly string[]): boolean => {
  if (reasons.some((reason) => AUTH_REASON_CODES.has(reason))) {
    return true;
  }

  if (event && typeof event === 'object') {
    const anomalyDetails = event._anomalyDetails;
    if (anomalyDetails && typeof anomalyDetails === 'object') {
      const detailReason = normalizeLower((anomalyDetails as Record<string, unknown>).reason);
      if (detailReason && AUTH_REASON_CODES.has(detailReason)) {
        return true;
      }
    }

    const metadata = event.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const authInfo = (metadata as Record<string, unknown>).auth;
      if (authInfo && typeof authInfo === 'object' && !Array.isArray(authInfo)) {
        const status = normalizeLower((authInfo as Record<string, unknown>).status);
        if (status && AUTH_STATUS_VALUES.has(status)) {
          return true;
        }
        const authReason = normalizeLower((authInfo as Record<string, unknown>).reason);
        if (authReason && AUTH_REASON_CODES.has(authReason)) {
          return true;
        }
      }
    }

    if (event.authTokenValid === false || event.sessionSpoofed === true) {
      return true;
    }
  }

  return false;
};

const determineLabel = (event: SimulationEvent | null | undefined): string => {
  const candidates: string[] = [];
  const pushCandidate = (label: string | null) => {
    if (!label) {
      return;
    }
    if (!candidates.includes(label)) {
      candidates.push(label);
    }
  };

  const markLabel = resolveMarkLabel(event);
  pushCandidate(markLabel);

  const protocolFlag = event && event.protocolViolationFlag === true;
  const protocolReasons = collectProtocolReasons(event);
  if (hasAuthFailureIndicator(event, protocolReasons)) {
    pushCandidate('auth_failure');
  }

  if (protocolFlag) {
    if (!hasAuthFailureIndicator(event, protocolReasons)) {
      pushCandidate('protocol_violation');
    }
  }

  if (event && event.timeDeviationFlag === true) {
    pushCandidate('time_deviation');
  }

  if (candidates.length === 0) {
    return 'normal';
  }

  let selected = candidates[0];
  let bestRank = PRIORITY_ORDER[selected] ?? Number.POSITIVE_INFINITY;
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const rank = PRIORITY_ORDER[candidate] ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      selected = candidate;
      bestRank = rank;
    }
  }
  return selected;
};

const cloneMetadata = (metadata: SimulationEventMetadata | undefined): SimulationEventMetadata => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return { ...metadata };
};

export const labelSequence = (sequence: readonly SimulationEvent[]): LabeledEvent[] => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  return sequence.map((event) => {
    const baseEvent = event ?? {};
    const label = determineLabel(baseEvent);
    const anomalyFlag = label !== 'normal';
    const metadata = cloneMetadata((baseEvent as SimulationEvent).metadata);
    metadata.anomaly = label;

    const derivedAnomaly = baseEvent.anomaly === true || anomalyFlag;
    const anomalyLabel = derivedAnomaly ? 1 : 0;

    return {
      ...(baseEvent as Record<string, unknown>),
      anomaly: derivedAnomaly,
      anomalyLabel,
      anomaly_type: label,
      metadata,
    } as LabeledEvent;
  });
};

const labeler = {
  labelSequence,
};

export default labeler;
