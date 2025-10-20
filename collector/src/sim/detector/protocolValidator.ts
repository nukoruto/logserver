import type { SimulationEvent } from '../../services/simulationService';

export interface ProtocolValidatorOptions extends Record<string, unknown> {
  loginEvents?: readonly unknown[];
  logoutEvents?: readonly unknown[];
  authCategories?: readonly unknown[];
  requireAuthCategories?: readonly unknown[];
  eventCategoryMap?: Record<string, unknown>;
  sessionIdField?: string;
  userIdField?: string;
  tokenField?: string;
  sessionIdPattern?: RegExp;
  allowedTransitions?: readonly UnknownTransition[];
}

export interface ProtocolAnnotatedEvent extends SimulationEvent {
  protocolViolationFlag?: boolean;
  protocolViolationReasons?: string[];
  protocolViolationState?: Record<string, unknown>;
}

interface UnknownTransition {
  from?: unknown;
  to?: unknown;
}

interface SessionContext {
  sessionId: string | null;
  authenticated: boolean;
  terminated: boolean;
  seenAuth: boolean;
  lastEventName: string | null;
  userId: string | null;
  tokenId: string | null;
  processedCount: number;
}

interface NormalizedOptions extends ProtocolValidatorOptions {
  loginEvents: readonly unknown[];
  logoutEvents: readonly unknown[];
  authCategories: readonly unknown[];
  requireAuthCategories: readonly unknown[];
  eventCategoryMap: Record<string, unknown>;
  sessionIdField: string;
  userIdField: string;
  tokenField: string;
  sessionIdPattern: RegExp;
  allowedTransitions: readonly UnknownTransition[];
  requireAuthCategorySet: Set<string>;
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  loginEvents: ['login'],
  logoutEvents: ['logout'],
  authCategories: ['AUTH'],
  requireAuthCategories: ['READ', 'UPDATE', 'WRITE', 'DELETE', 'ADMIN'],
  eventCategoryMap: {
    login: 'AUTH',
    logout: 'AUTH',
    browse: 'READ',
    view: 'READ',
    read: 'READ',
    edit: 'UPDATE',
    save: 'UPDATE',
    update: 'UPDATE',
    delete: 'UPDATE',
  },
  sessionIdField: 'session_id',
  userIdField: 'user_id',
  tokenField: 'uid',
  sessionIdPattern: /^[A-Za-z0-9:_-]{8,}$/u,
  allowedTransitions: [
    { from: 'login', to: 'browse' },
    { from: 'login', to: 'logout' },
    { from: 'browse', to: 'browse' },
    { from: 'browse', to: 'edit' },
    { from: 'browse', to: 'logout' },
    { from: 'edit', to: 'save' },
    { from: 'edit', to: 'browse' },
    { from: 'edit', to: 'logout' },
    { from: 'save', to: 'logout' },
  ],
  requireAuthCategorySet: new Set<string>(),
};

const NORMALIZED_TRANSITION_CACHE = new WeakMap<object, Set<string>>();

const normalizeString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const normalizeEventName = (event: SimulationEvent | null | undefined): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const candidates = [event.event, (event as Record<string, unknown>).action, (event as Record<string, unknown>).operation, (event as Record<string, unknown>).type];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized.toLowerCase();
    }
  }
  return null;
};

const normalizeCategory = (
  event: SimulationEvent | null | undefined,
  options: NormalizedOptions,
): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const baseEvent = event as Record<string, unknown>;
  const candidates = [baseEvent.op_category, baseEvent.category, baseEvent.category_code];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized.toUpperCase();
    }
  }
  const eventName = normalizeEventName(event);
  if (!eventName) {
    return null;
  }
  const mapped = options.eventCategoryMap[eventName];
  return typeof mapped === 'string' ? mapped.toUpperCase() : null;
};

const resolveField = (
  event: SimulationEvent | null | undefined,
  primary: unknown,
  fallbacks: readonly string[] = [],
): string | null => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const lookupOrder = [primary, ...fallbacks];
  for (const key of lookupOrder) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      const normalized = normalizeString((event as Record<string, unknown>)[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
};

const normalizeTransitionSet = (options: NormalizedOptions): Set<string> => {
  if (!options) {
    return new Set();
  }
  if (NORMALIZED_TRANSITION_CACHE.has(options)) {
    return NORMALIZED_TRANSITION_CACHE.get(options) as Set<string>;
  }
  const transitions = Array.isArray(options.allowedTransitions)
    ? options.allowedTransitions
    : Array.isArray(DEFAULT_OPTIONS.allowedTransitions)
      ? DEFAULT_OPTIONS.allowedTransitions
      : [];
  const set = new Set<string>();
  transitions.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const fromName = normalizeString((item as UnknownTransition).from);
    const toName = normalizeString((item as UnknownTransition).to);
    if (!fromName || !toName) {
      return;
    }
    set.add(`${fromName.toLowerCase()}->${toName.toLowerCase()}`);
  });
  NORMALIZED_TRANSITION_CACHE.set(options, set);
  return set;
};

const createSessionContext = (sessionId: string | null): SessionContext => ({
  sessionId,
  authenticated: false,
  terminated: false,
  seenAuth: false,
  lastEventName: null,
  userId: null,
  tokenId: null,
  processedCount: 0,
});

const resolveSessionKey = (sessionId: string | null): string => sessionId ?? '__MISSING_SESSION__';

const collectReasons = (reasons: readonly (string | null | undefined)[]): string[] =>
  Array.from(new Set(reasons.filter((reason): reason is string => Boolean(reason))));

const shouldRequireAuth = (category: string | null, options: NormalizedOptions): boolean => {
  if (!category) {
    return false;
  }
  const target = String(category).toUpperCase();
  return options.requireAuthCategorySet.has(target);
};

export const validateProtocol = (
  sequence: readonly SimulationEvent[],
  userOptions: ProtocolValidatorOptions = {},
): ProtocolAnnotatedEvent[] => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const mergedOptions: NormalizedOptions = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
    requireAuthCategorySet: new Set<string>(),
  };

  const loginEventSet = new Set(
    Array.isArray(mergedOptions.loginEvents)
      ? mergedOptions.loginEvents
          .map((item) => normalizeString(item))
          .filter((value): value is string => Boolean(value))
          .map((name) => name.toLowerCase())
      : DEFAULT_OPTIONS.loginEvents.map((name) =>
          typeof name === 'string' ? name.toLowerCase() : String(name).toLowerCase(),
        ),
  );
  const logoutEventSet = new Set(
    Array.isArray(mergedOptions.logoutEvents)
      ? mergedOptions.logoutEvents
          .map((item) => normalizeString(item))
          .filter((value): value is string => Boolean(value))
          .map((name) => name.toLowerCase())
      : DEFAULT_OPTIONS.logoutEvents.map((name) =>
          typeof name === 'string' ? name.toLowerCase() : String(name).toLowerCase(),
        ),
  );
  const authCategorySet = new Set(
    Array.isArray(mergedOptions.authCategories)
      ? mergedOptions.authCategories
          .map((item) => normalizeString(item))
          .filter((value): value is string => Boolean(value))
          .map((item) => item.toUpperCase())
      : DEFAULT_OPTIONS.authCategories.map((item) =>
          typeof item === 'string' ? item.toUpperCase() : String(item).toUpperCase(),
        ),
  );
  const requireAuthCategorySet = new Set(
    Array.isArray(mergedOptions.requireAuthCategories)
      ? mergedOptions.requireAuthCategories
          .map((item) => normalizeString(item))
          .filter((value): value is string => Boolean(value))
          .map((item) => item.toUpperCase())
      : DEFAULT_OPTIONS.requireAuthCategories.map((item) =>
          typeof item === 'string' ? item.toUpperCase() : String(item).toUpperCase(),
        ),
  );

  mergedOptions.requireAuthCategorySet = requireAuthCategorySet;

  const transitionSet = normalizeTransitionSet(mergedOptions);
  const contexts = new Map<string, SessionContext>();

  return sequence.map((rawEvent) => {
    const event = (rawEvent ?? {}) as SimulationEvent;
    const eventName = normalizeEventName(event);
    const category = normalizeCategory(event, mergedOptions);
    const sessionId = resolveField(event, mergedOptions.sessionIdField, ['sessionId', 'session']);
    const userId = resolveField(event, mergedOptions.userIdField, ['userId']);
    const tokenId = resolveField(event, mergedOptions.tokenField, ['token', 'token_id', 'auth_token']);

    const contextKey = resolveSessionKey(sessionId);
    const context = contexts.get(contextKey) ?? createSessionContext(sessionId);
    contexts.set(contextKey, context);

    const reasons: Array<string | null> = [];

    if (!sessionId) {
      reasons.push('missingSessionId');
    } else if (
      mergedOptions.sessionIdPattern instanceof RegExp &&
      !mergedOptions.sessionIdPattern.test(sessionId)
    ) {
      reasons.push('invalidSessionIdFormat');
    }

    if (context.processedCount === 0) {
      if (!eventName || !loginEventSet.has(eventName)) {
        reasons.push('missingInitialLogin');
      }
    }

    const isLoginEvent = eventName ? loginEventSet.has(eventName) : false;
    const isLogoutEvent = eventName ? logoutEventSet.has(eventName) : false;
    const isAuthCategory = category ? authCategorySet.has(category) : false;
    const requiresAuth = shouldRequireAuth(category, mergedOptions);

    if (context.terminated && !isLoginEvent) {
      reasons.push('postLogoutOperation');
    }

    if (isLoginEvent) {
      if (context.authenticated && !context.terminated) {
        reasons.push('duplicateLogin');
      }
      if (context.terminated) {
        reasons.push('postLogoutOperation');
      }
      context.authenticated = true;
      context.seenAuth = true;
      context.terminated = false;
    }

    if (isLogoutEvent) {
      if (!context.authenticated) {
        reasons.push('logoutWithoutLogin');
      }
      context.authenticated = false;
      context.terminated = true;
    }

    if (isAuthCategory && !isLoginEvent && !isLogoutEvent && !context.authenticated) {
      reasons.push('unauthenticatedOperation');
    }

    if (requiresAuth && !context.authenticated) {
      reasons.push(context.seenAuth ? 'unauthenticatedOperation' : 'unauthenticatedBeforeLogin');
    }

    if (context.userId && userId && context.userId !== userId) {
      reasons.push('userIdMismatch');
    }
    if (!context.userId && userId) {
      context.userId = userId;
    }

    if (context.tokenId && tokenId && context.tokenId !== tokenId) {
      reasons.push('tokenMismatch');
    }
    if (!context.tokenId && tokenId) {
      context.tokenId = tokenId;
    }

    if (context.lastEventName && eventName && !isLoginEvent) {
      const key = `${context.lastEventName}->${eventName}`;
      if (transitionSet.size > 0 && !transitionSet.has(key)) {
        reasons.push('disallowedTransition');
      }
    }

    context.lastEventName = eventName ?? context.lastEventName;
    context.processedCount += 1;

    const deduplicatedReasons = collectReasons(reasons);

    return {
      ...(event as Record<string, unknown>),
      protocolViolationFlag: deduplicatedReasons.length > 0,
      protocolViolationReasons: deduplicatedReasons,
      protocolViolationState: {
        authenticated: context.authenticated,
        terminated: context.terminated,
        seenAuth: context.seenAuth,
        lastEventName: context.lastEventName,
      },
    };
  });
};

const protocolValidator = {
  validateProtocol,
};

export default protocolValidator;
