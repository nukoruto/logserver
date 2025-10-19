import { URL } from 'node:url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const INT_RE = /^\d+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,}$/;
const NON_ALNUM_RE = /[^a-z0-9{}]+/g;
const MULTI_DASH_RE = /-+/g;
const DIGIT_GROUP_RE = /\d+/g;

function normaliseSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    return 'root';
  }
  if (UUID_RE.test(trimmed)) {
    return '{uuid}';
  }
  if (INT_RE.test(trimmed)) {
    return '{int}';
  }
  if (HEX_RE.test(trimmed)) {
    return '{hex}';
  }
  if (TOKEN_RE.test(trimmed)) {
    return '{token}';
  }
  const lowered = trimmed.toLowerCase();
  const replacedDigits = lowered.replace(DIGIT_GROUP_RE, '{num}');
  const substituted = replacedDigits.replace(NON_ALNUM_RE, '-');
  const collapsed = substituted.replace(MULTI_DASH_RE, '-').replace(/^-|-$/g, '');
  return collapsed || '{token}';
}

function sanitisePathCandidate(raw: string): string {
  let candidate = raw;
  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw);
      candidate = parsed.pathname || raw;
    } catch {
      candidate = raw;
    }
  }
  const queryIndex = candidate.indexOf('?');
  if (queryIndex >= 0) {
    candidate = candidate.slice(0, queryIndex);
  }
  const hashIndex = candidate.indexOf('#');
  if (hashIndex >= 0) {
    candidate = candidate.slice(0, hashIndex);
  }
  if (!candidate.startsWith('/')) {
    return candidate;
  }
  return candidate;
}

export function normalisePathTemplate(pathValue: unknown): string {
  const raw = typeof pathValue === 'string' ? pathValue.trim() : pathValue == null ? '' : String(pathValue).trim();
  if (!raw) {
    return 'root';
  }
  const candidate = sanitisePathCandidate(raw);
  const segments = candidate.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return 'root';
  }
  const normalised = segments.map(normaliseSegment);
  return normalised.join('/');
}

function normalizeMethod(method: unknown): string {
  if (typeof method === 'string') {
    const trimmed = method.trim();
    return trimmed.length > 0 ? trimmed.toUpperCase() : 'UNKNOWN';
  }
  if (method == null) {
    return 'UNKNOWN';
  }
  const value = String(method).trim();
  return value.length > 0 ? value.toUpperCase() : 'UNKNOWN';
}

function normalizeCategory(opCategory: unknown): string {
  if (typeof opCategory === 'string') {
    const trimmed = opCategory.trim();
    return trimmed.length > 0 ? trimmed.toUpperCase() : 'UNKNOWN';
  }
  if (opCategory == null) {
    return 'UNKNOWN';
  }
  const value = String(opCategory).trim();
  return value.length > 0 ? value.toUpperCase() : 'UNKNOWN';
}

export function deriveTemplateId(method: unknown, pathValue: unknown, opCategory: unknown): string {
  const methodStr = normalizeMethod(method);
  const category = normalizeCategory(opCategory);
  const templatePath = normalisePathTemplate(pathValue);
  return `${category}::${methodStr}::${templatePath}`;
}

