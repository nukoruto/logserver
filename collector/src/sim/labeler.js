'use strict';

const MARK_FIELD_CANDIDATES = ['_anomalyType', 'anomalyType', 'anomaly_type'];
const MARK_TYPE_MAP = {
  authenticationbypass: 'auth_failure',
  'auth_failure': 'auth_failure',
  protocolviolation: 'protocol_violation',
  'protocol_violation': 'protocol_violation',
  timedeviation: 'time_deviation',
  'time_deviation': 'time_deviation',
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

const PRIORITY_ORDER = {
  auth_failure: 1,
  protocol_violation: 2,
  time_deviation: 3,
};

const normalizeString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeLower = (value) => {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
};

const resolveMarkLabel = (event) => {
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

const collectProtocolReasons = (event) => {
  if (!event || typeof event !== 'object') {
    return [];
  }
  const reasons = Array.isArray(event.protocolViolationReasons)
    ? event.protocolViolationReasons
    : [];
  return reasons
    .map((reason) => normalizeLower(reason))
    .filter((reason) => typeof reason === 'string' && reason.length > 0);
};

const hasAuthFailureIndicator = (event, reasons) => {
  if (reasons.some((reason) => AUTH_REASON_CODES.has(reason))) {
    return true;
  }

  if (event && typeof event === 'object') {
    const anomalyDetails = event._anomalyDetails;
    if (anomalyDetails && typeof anomalyDetails === 'object') {
      const detailReason = normalizeLower(anomalyDetails.reason);
      if (detailReason && AUTH_REASON_CODES.has(detailReason)) {
        return true;
      }
    }

    const metadata = event.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const authInfo = metadata.auth;
      if (authInfo && typeof authInfo === 'object' && !Array.isArray(authInfo)) {
        const status = normalizeLower(authInfo.status);
        if (status && AUTH_STATUS_VALUES.has(status)) {
          return true;
        }
        const authReason = normalizeLower(authInfo.reason);
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

const determineLabel = (event) => {
  const candidates = [];
  const pushCandidate = (label) => {
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

const cloneMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return { ...metadata };
};

const labelSequence = (sequence) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  return sequence.map((event) => {
    const label = determineLabel(event || {});
    const anomalyFlag = label !== 'normal';
    const metadata = cloneMetadata(event && event.metadata);
    metadata.anomaly = label;

    const base = event && typeof event === 'object' ? event : {};

    const derivedAnomaly = base.anomaly === true || anomalyFlag;
    const anomalyLabel = derivedAnomaly ? 1 : 0;

    return {
      ...base,
      anomaly: derivedAnomaly,
      anomalyLabel,
      anomaly_type: label,
      metadata,
    };
  });
};

module.exports = {
  labelSequence,
};
