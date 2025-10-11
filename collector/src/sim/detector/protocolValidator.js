'use strict';

const DEFAULT_OPTIONS = {
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
  sessionIdPattern: /^[A-Za-z0-9:_\-]{8,}$/u,
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
};

const NORMALIZED_TRANSITION_CACHE = new WeakMap();

const normalizeString = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const normalizeEventName = (event) => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const candidates = [event.event, event.action, event.operation, event.type];
  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized.toLowerCase();
    }
  }
  return null;
};

const normalizeCategory = (event, options) => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const candidates = [event.op_category, event.category, event.category_code];
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
  return mapped ? mapped.toUpperCase() : null;
};

const resolveField = (event, primary, fallbacks = []) => {
  if (!event || typeof event !== 'object') {
    return null;
  }
  const lookupOrder = [primary, ...fallbacks];
  for (const key of lookupOrder) {
    if (!key) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      const normalized = normalizeString(event[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
};

const normalizeTransitionSet = (options) => {
  if (!options) {
    return new Set();
  }
  if (NORMALIZED_TRANSITION_CACHE.has(options)) {
    return NORMALIZED_TRANSITION_CACHE.get(options);
  }
  const transitions = Array.isArray(options.allowedTransitions)
    ? options.allowedTransitions
    : Array.isArray(DEFAULT_OPTIONS.allowedTransitions)
      ? DEFAULT_OPTIONS.allowedTransitions
      : [];
  const set = new Set();
  transitions.forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const fromName = normalizeString(item.from);
    const toName = normalizeString(item.to);
    if (!fromName || !toName) {
      return;
    }
    set.add(`${fromName.toLowerCase()}->${toName.toLowerCase()}`);
  });
  NORMALIZED_TRANSITION_CACHE.set(options, set);
  return set;
};

const createSessionContext = (sessionId) => ({
  sessionId,
  authenticated: false,
  terminated: false,
  seenAuth: false,
  lastEventName: null,
  userId: null,
  tokenId: null,
  processedCount: 0,
});

const resolveSessionKey = (sessionId) => sessionId || '__MISSING_SESSION__';

const collectReasons = (reasons) => Array.from(new Set(reasons.filter(Boolean)));

const shouldRequireAuth = (category, options) => {
  if (!category) {
    return false;
  }
  const target = String(category).toUpperCase();
  return options.requireAuthCategorySet.has(target);
};

const validateProtocol = (sequence, userOptions = {}) => {
  if (!Array.isArray(sequence)) {
    return [];
  }

  const mergedOptions = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
  };

  const loginEventSet = new Set(
    Array.isArray(mergedOptions.loginEvents)
      ? mergedOptions.loginEvents
          .map((item) => normalizeString(item))
          .filter(Boolean)
          .map((name) => name.toLowerCase())
      : DEFAULT_OPTIONS.loginEvents.map((name) => name.toLowerCase())
  );
  const logoutEventSet = new Set(
    Array.isArray(mergedOptions.logoutEvents)
      ? mergedOptions.logoutEvents
          .map((item) => normalizeString(item))
          .filter(Boolean)
          .map((name) => name.toLowerCase())
      : DEFAULT_OPTIONS.logoutEvents.map((name) => name.toLowerCase())
  );
  const authCategorySet = new Set(
    Array.isArray(mergedOptions.authCategories)
      ? mergedOptions.authCategories.map((item) => normalizeString(item)).filter(Boolean).map((item) => item.toUpperCase())
      : DEFAULT_OPTIONS.authCategories.map((item) => item.toUpperCase())
  );
  const requireAuthCategorySet = new Set(
    Array.isArray(mergedOptions.requireAuthCategories)
      ? mergedOptions.requireAuthCategories
          .map((item) => normalizeString(item))
          .filter(Boolean)
          .map((item) => item.toUpperCase())
      : DEFAULT_OPTIONS.requireAuthCategories.map((item) => item.toUpperCase())
  );

  mergedOptions.requireAuthCategorySet = requireAuthCategorySet;

  const transitionSet = normalizeTransitionSet(mergedOptions);
  const contexts = new Map();

  return sequence.map((event) => {
    const eventName = normalizeEventName(event);
    const category = normalizeCategory(event, mergedOptions);
    const sessionId = resolveField(event, mergedOptions.sessionIdField, ['sessionId', 'session']);
    const userId = resolveField(event, mergedOptions.userIdField, ['userId']);
    const tokenId = resolveField(event, mergedOptions.tokenField, ['token', 'token_id', 'auth_token']);

    const contextKey = resolveSessionKey(sessionId);
    const context = contexts.get(contextKey) || createSessionContext(sessionId);
    contexts.set(contextKey, context);

    const reasons = [];

    if (!sessionId) {
      reasons.push('missingSessionId');
    } else if (mergedOptions.sessionIdPattern instanceof RegExp && !mergedOptions.sessionIdPattern.test(sessionId)) {
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

    context.lastEventName = eventName || context.lastEventName;
    context.processedCount += 1;

    const deduplicatedReasons = collectReasons(reasons);

    return {
      ...event,
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

module.exports = {
  validateProtocol,
};
