import { createReadStream, promises as fsPromises } from 'node:fs';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { parse } from 'csv-parse';

export const algoVersion = "otsu+kneedle-v1" as const;

export type SplitReason =
  | "initial"
  | "continuous"
  | "idle_timeout"
  | "timestamp_regression"
  | "session_id_change";

export interface SessionSplitOptions {
  idleTimeoutSeconds?: number;
  timestampColumn?: string;
  userIdColumn?: string;
  sessionIdColumn?: string;
  jwtHmacKey?: string | Buffer;
  datasetKey?: string | Buffer;
}

export interface ThresholdBackoffOptions {
  groupKey?: string | ((row: AugmentedRow) => string | null | undefined);
  defaultGroup?: string;
  label?: string;
}

export interface ThresholdEstimationOptions {
  minimumSamples?: number;
  fallbackPercentile?: number;
  knee?: KneeDetectionOptions;
  min_events?: number;
  minEvents?: number;
  backoff?: boolean | ThresholdBackoffOptions;
  concurrency?: number;
  shard_dir?: string;
}

export interface KneeDetectionOptions {
  logStep?: number;
  kSigma?: number;
  smoothingWindow?: number;
  minCandidates?: number;
}

export interface LogHistogramOptions {
  minBinCount?: number;
  maxBinCount?: number;
  decimals?: number;
  logBase?: number;
}

export interface LogHistogramResult {
  binEdges: number[];
  binCounts: number[];
  binCount: number;
  logBinWidth: number;
  domain: {
    min: number;
    max: number;
    logMin: number;
    logMax: number;
  };
}

export interface LogOtsuThresholdResult {
  tauLog: number;
  quality: number;
}

export interface BimodalityTestResult {
  bicDifference: number;
}

export interface AugmentedRow {
  algo_ver: typeof algoVersion;
  uid: string;
  generatedSessionId: string;
  sessionSequence: number;
  sessionIndex: number;
  timestampUtc: string;
  deltaSeconds: number | null;
  idleTimeoutSeconds: number;
  splitReason: SplitReason;
  originalSessionId?: string;
  original: Record<string, string>;
}

export type ThresholdMap = Map<string, number> & { readonly algo_ver: typeof algoVersion };

export interface ThresholdDetail {
  fd_bins: number;
  tau_otsu: number | null;
  tau_knee: number | null;
  tau_final: number;
  DeltaT: number;
  bimodality_test: number | null;
  backoff_level: string;
}

export interface ThresholdComputationResult {
  thresholds: ThresholdMap;
  perUser: Map<string, ThresholdDetail>;
  k: number;
  scan_step: number;
}

export interface KneeCurvePoint {
  threshold: number;
  logThreshold: number;
  count: number;
  smoothed: number;
}

export interface KneeCurveSummary {
  threshold: number;
  logThreshold: number;
}

export interface KneeCurve {
  points: KneeCurvePoint[];
  knee: KneeCurveSummary;
}

export interface ThresholdMetaInput {
  algo_ver: typeof algoVersion;
  epsilon: number;
  ntp_p95_ms: number;
  ingress_jitter_ms: number;
  fd_bins: Record<string, number>;
  tau_otsu: Record<string, number | null>;
  tau_knee: Record<string, number | null>;
  tau_final: Record<string, number>;
  DeltaT: Record<string, number>;
  bimodality_test: Record<string, number | null>;
  backoff_level: Record<string, string>;
  k: number;
  scan_step: number;
  hkdf_info: string;
  kid: string;
  datasetPath: string;
  thresholds_by_uid: Record<string, number>;
}

export interface ThresholdMeta extends Omit<ThresholdMetaInput, 'datasetPath'> {
  dataset_hash: string;
}

interface SessionTracker {
  counter: number;
  generatedSessionId: string;
  sessionStartMs: number;
  sessionStartEpochSeconds: number;
  lastTimestampMs: number;
  sessionIndex: number;
  lastOriginalSessionId?: string;
}

interface NormalizedOptions {
  idleTimeoutSeconds: number;
  timestampColumn: string;
  userIdColumn: string;
  sessionIdColumn?: string;
  datasetKey: Buffer;
}

interface NormalizedLogHistogramOptions {
  minBinCount: number;
  maxBinCount: number;
  decimals: number;
  logBase: number;
}

const LOG_HISTOGRAM_DEFAULTS: NormalizedLogHistogramOptions = {
  minBinCount: 32,
  maxBinCount: 512,
  decimals: 9,
  logBase: Math.E
};

const LOG_OTSU_QUALITY_MIN = 0.25;
const DEFAULT_MIN_EVENTS = 50;
const DEFAULT_BACKOFF_COLUMN = "user_agent_type";
const DEFAULT_BACKOFF_UNKNOWN = "unknown";
const MIN_BIMODAL_SAMPLES = 6;
const MIN_COMPONENT_WEIGHT = 0.1;
const MIN_VARIANCE = 1e-6;
const EM_MAX_ITERATIONS = 128;
const EM_TOLERANCE = 1e-6;
const SID_INFO = Buffer.from('sid', 'utf8');
const HKDF_OUTPUT_LENGTH = 32;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

function isProbablyHex(value: string): boolean {
  return HEX_PATTERN.test(value) && value.length % 2 === 0;
}

function decodeBase64Strict(value: string, label: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0) {
      throw new SessionSplitterError(`${label} decoded to empty buffer`);
    }
    const normalisedInput = value.replace(/=+$/u, "");
    const reencoded = decoded.toString('base64').replace(/=+$/u, "");
    if (normalisedInput !== reencoded) {
      throw new SessionSplitterError(`${label} contained invalid base64 characters`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof SessionSplitterError) {
      throw error;
    }
    throw new SessionSplitterError(`${label} must be base64 or hex encoded`);
  }
}

function parseSecret(raw: string | Buffer, label: string): Buffer {
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) {
      throw new SessionSplitterError(`${label} cannot be empty`);
    }
    return Buffer.from(raw);
  }
  if (typeof raw !== 'string') {
    throw new SessionSplitterError(`${label} must be provided as a string or Buffer`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SessionSplitterError(`${label} cannot be empty`);
  }
  if (isProbablyHex(trimmed)) {
    const buffer = Buffer.from(trimmed, 'hex');
    if (buffer.length === 0) {
      throw new SessionSplitterError(`${label} decoded to empty buffer`);
    }
    return buffer;
  }
  return decodeBase64Strict(trimmed, label);
}

export function deriveDatasetKey(jwtHmacKey: string | Buffer): Buffer {
  const ikm = parseSecret(jwtHmacKey, 'JWT_HMAC_KEY');
  const derived = hkdfSync('sha256', ikm, Buffer.alloc(0), SID_INFO, HKDF_OUTPUT_LENGTH);
  return Buffer.from(derived);
}

export function makeSid(
  uid: string,
  tStartEpochSeconds: number,
  algoVer: string,
  datasetKey: Buffer
): string {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new SessionSplitterError('uid is required to generate session identifier');
  }
  if (!Number.isFinite(tStartEpochSeconds)) {
    throw new SessionSplitterError('tStartEpochSeconds must be finite');
  }
  if (typeof algoVer !== 'string' || algoVer.length === 0) {
    throw new SessionSplitterError('algoVer is required to generate session identifier');
  }
  if (!Buffer.isBuffer(datasetKey) || datasetKey.length === 0) {
    throw new SessionSplitterError('datasetKey must be a non-empty Buffer');
  }
  const epoch = Math.trunc(tStartEpochSeconds);
  const message = `${uid}|${epoch}|${algoVer}`;
  return createHmac('sha256', datasetKey).update(message, 'utf8').digest('hex');
}

function resolveDatasetKey(options: SessionSplitOptions): Buffer {
  if (options.datasetKey) {
    return parseSecret(options.datasetKey, 'datasetKey');
  }
  const source = options.jwtHmacKey ?? process.env.JWT_HMAC_KEY;
  if (!source) {
    throw new SessionSplitterError(
      'JWT_HMAC_KEY is required to derive deterministic session identifiers'
    );
  }
  return deriveDatasetKey(source);
}

export class SessionSplitterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SessionSplitterError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const DEFAULT_OPTIONS: NormalizedOptions = {
  idleTimeoutSeconds: 1800,
  timestampColumn: "timestamp_utc",
  userIdColumn: "uid",
  datasetKey: Buffer.alloc(0)
};

function normalizeOptions(options: SessionSplitOptions = {}): NormalizedOptions {
  const datasetKey = resolveDatasetKey(options);
  return {
    idleTimeoutSeconds: options.idleTimeoutSeconds ?? DEFAULT_OPTIONS.idleTimeoutSeconds,
    timestampColumn: options.timestampColumn ?? DEFAULT_OPTIONS.timestampColumn,
    userIdColumn: options.userIdColumn ?? DEFAULT_OPTIONS.userIdColumn,
    sessionIdColumn: options.sessionIdColumn,
    datasetKey
  };
}

function normalizeLogHistogramOptions(
  options: LogHistogramOptions = {}
): NormalizedLogHistogramOptions {
  const minCandidate = Math.floor(options.minBinCount ?? LOG_HISTOGRAM_DEFAULTS.minBinCount);
  const maxCandidate = Math.floor(options.maxBinCount ?? LOG_HISTOGRAM_DEFAULTS.maxBinCount);
  const decimalsCandidate = Math.floor(options.decimals ?? LOG_HISTOGRAM_DEFAULTS.decimals);
  const logBaseCandidate = options.logBase ?? LOG_HISTOGRAM_DEFAULTS.logBase;

  const clippedMin = Math.min(
    LOG_HISTOGRAM_DEFAULTS.maxBinCount,
    Math.max(LOG_HISTOGRAM_DEFAULTS.minBinCount, Math.max(1, minCandidate))
  );
  const clippedMax = Math.min(
    LOG_HISTOGRAM_DEFAULTS.maxBinCount,
    Math.max(clippedMin, Math.max(1, maxCandidate))
  );
  const decimals = Math.min(12, Math.max(0, decimalsCandidate));
  const logBase = logBaseCandidate > 1 ? logBaseCandidate : LOG_HISTOGRAM_DEFAULTS.logBase;

  return {
    minBinCount: clippedMin,
    maxBinCount: clippedMax,
    decimals,
    logBase
  };
}

function ensureReadable(input: string | Readable): Readable {
  if (typeof input === "string") {
    return createReadStream(input, { encoding: "utf8" });
  }
  return input;
}

function startNewSession(
  userId: string,
  timestampMs: number,
  tracker: SessionTracker | undefined,
  originalSessionId: string | undefined,
  datasetKey: Buffer
): SessionTracker {
  const nextCounter = tracker ? tracker.counter + 1 : 0;
  const sessionStartEpochSeconds = Math.trunc(timestampMs / 1000);
  return {
    counter: nextCounter,
    generatedSessionId: makeSid(userId, sessionStartEpochSeconds, algoVersion, datasetKey),
    sessionStartMs: timestampMs,
    sessionStartEpochSeconds,
    lastTimestampMs: timestampMs,
    sessionIndex: 0,
    lastOriginalSessionId: originalSessionId
  };
}

function updateExistingSession(
  tracker: SessionTracker,
  timestampMs: number,
  originalSessionId: string | undefined
): SessionTracker {
  return {
    ...tracker,
    sessionIndex: tracker.sessionIndex + 1,
    lastTimestampMs: timestampMs,
    lastOriginalSessionId: originalSessionId
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTimestamp(value: string, column: string): number {
  if (value === undefined || value === null) {
    throw new SessionSplitterError(`Invalid timestamp in column ${column}: ${value}`);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) >= 1e12 ? numeric : numeric * 1000;
    return milliseconds;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SessionSplitterError(`Invalid timestamp in column ${column}: ${value}`);
  }
  return parsed;
}

export async function* splitSessions(
  csvStreamOrPath: string | Readable,
  options: SessionSplitOptions = {}
): AsyncGenerator<AugmentedRow> {
  const normalized = normalizeOptions(options);
  const stream = ensureReadable(csvStreamOrPath);
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true
  });
  const pipeline = stream.pipe(parser);
  const trackers = new Map<string, SessionTracker>();

  try {
    for await (const record of pipeline as AsyncIterable<Record<string, string>>) {
      const uid = record[normalized.userIdColumn];
      if (!uid) {
        throw new SessionSplitterError(
          `Missing user identifier in column ${normalized.userIdColumn}`
        );
      }
      const timestampValue = record[normalized.timestampColumn];
      if (!timestampValue) {
        throw new SessionSplitterError(
          `Missing timestamp in column ${normalized.timestampColumn}`
        );
      }
      const timestampMs = parseTimestamp(timestampValue, normalized.timestampColumn);
      const tracker = trackers.get(uid);
      const originalSessionId = normalized.sessionIdColumn
        ? record[normalized.sessionIdColumn]
        : undefined;

      let splitReason: SplitReason = "continuous";
      let nextTracker: SessionTracker;
      let deltaSeconds: number | null = null;

      if (!tracker) {
        nextTracker = startNewSession(
          uid,
          timestampMs,
          tracker,
          originalSessionId,
          normalized.datasetKey
        );
        splitReason = "initial";
      } else {
        deltaSeconds = (timestampMs - tracker.lastTimestampMs) / 1000;
        const idleTimeout = normalized.idleTimeoutSeconds;
        const sessionIdChanged =
          normalized.sessionIdColumn &&
          tracker.lastOriginalSessionId !== undefined &&
          originalSessionId !== tracker.lastOriginalSessionId;

        if (deltaSeconds < 0) {
          splitReason = "timestamp_regression";
          nextTracker = startNewSession(
            uid,
            timestampMs,
            tracker,
            originalSessionId,
            normalized.datasetKey
          );
          deltaSeconds = null;
        } else if (deltaSeconds > idleTimeout) {
          splitReason = "idle_timeout";
          nextTracker = startNewSession(
            uid,
            timestampMs,
            tracker,
            originalSessionId,
            normalized.datasetKey
          );
          deltaSeconds = null;
        } else if (sessionIdChanged) {
          splitReason = "session_id_change";
          nextTracker = startNewSession(
            uid,
            timestampMs,
            tracker,
            originalSessionId,
            normalized.datasetKey
          );
          deltaSeconds = null;
        } else {
          nextTracker = updateExistingSession(tracker, timestampMs, originalSessionId);
        }
      }

      trackers.set(uid, nextTracker);

      const row: AugmentedRow = {
        algo_ver: algoVersion,
        uid,
        generatedSessionId: nextTracker.generatedSessionId,
        sessionSequence: nextTracker.counter,
        sessionIndex: nextTracker.sessionIndex,
        timestampUtc: toIso(timestampMs),
        deltaSeconds,
        idleTimeoutSeconds: normalized.idleTimeoutSeconds,
        splitReason,
        originalSessionId,
        original: record
      };

      yield row;
    }
  } catch (error) {
    if (error instanceof SessionSplitterError) {
      throw error;
    }
    throw new SessionSplitterError("Failed to split sessions", error);
  } finally {
    const destroy = (stream as { destroy?: () => void }).destroy;
    if (typeof destroy === "function") {
      destroy.call(stream);
    }
  }
}

interface NormalizedBackoffOptions {
  enabled: boolean;
  resolve(row: AugmentedRow): string | null;
  describe(group: string | null): string;
}

interface ShardFileInfo {
  id: number;
  path: string;
  count: number;
}

interface ShardedAggregationResult {
  shards: ShardFileInfo[];
  userMeta: Map<string, string | null>;
  groupDeltas: Map<string, number[]>;
  globalDeltas: number[];
  userCounts: Map<string, number>;
}

interface WorkerUserSummary {
  threshold: number;
  detail: ThresholdDetailBase;
  count: number;
}

class UserShardAggregator {
  private static readonly BUFFER_SIZE = 2048;

  private readonly concurrency: number;

  private readonly shardCount: number;

  private readonly baseDir: string;

  private readonly cleanupRoot: string;

  private readonly buffers = new Map<number, string[]>();

  private readonly shardMap = new Map<number, ShardFileInfo>();

  private readonly pendingWrites: Promise<void>[] = [];

  private readonly userMeta = new Map<string, string | null>();

  private readonly groupDeltas = new Map<string, number[]>();

  private readonly globalDeltas: number[] = [];

  private readonly userCounts = new Map<string, number>();

  private closed = false;

  private constructor(baseDir: string, cleanupRoot: string, concurrency: number) {
    this.baseDir = baseDir;
    this.cleanupRoot = cleanupRoot;
    this.concurrency = Math.max(1, concurrency);
    this.shardCount = Math.max(1, this.concurrency * 2);
  }

  static async create(concurrency: number, shardDir?: string): Promise<UserShardAggregator> {
    const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
    if (shardDir && shardDir.trim().length > 0) {
      const resolved = path.resolve(shardDir);
      await fsPromises.mkdir(resolved, { recursive: true });
      const unique = `session-shards-${process.pid}-${Date.now()}`;
      const baseDir = path.join(resolved, unique);
      await fsPromises.mkdir(baseDir, { recursive: true });
      return new UserShardAggregator(baseDir, baseDir, normalizedConcurrency);
    }
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${process.pid}-session-shards-`));
    return new UserShardAggregator(tempRoot, tempRoot, normalizedConcurrency);
  }

  registerUser(uid: string, groupKey: string | null): void {
    const existing = this.userMeta.get(uid);
    if (existing === undefined) {
      this.userMeta.set(uid, groupKey);
      return;
    }
    if (existing === null && groupKey !== null) {
      this.userMeta.set(uid, groupKey);
    }
  }

  addDelta(uid: string, delta: number, groupKey: string | null): void {
    if (this.closed) {
      throw new SessionSplitterError('Aggregator already closed');
    }
    this.registerUser(uid, groupKey);
    if (!Number.isFinite(delta) || delta <= 0) {
      return;
    }
    this.globalDeltas.push(delta);
    this.userCounts.set(uid, (this.userCounts.get(uid) ?? 0) + 1);
    if (groupKey !== null) {
      const groupList = this.groupDeltas.get(groupKey);
      if (groupList) {
        groupList.push(delta);
      } else {
        this.groupDeltas.set(groupKey, [delta]);
      }
    }
    const shardIndex = this.computeShardIndex(uid);
    const buffer = this.ensureBuffer(shardIndex);
    buffer.push(`${uid}\t${delta.toString()}\n`);
    if (buffer.length >= UserShardAggregator.BUFFER_SIZE) {
      this.flushBuffer(shardIndex, buffer);
    }
  }

  finalize(): ShardedAggregationResult {
    if (this.closed) {
      throw new SessionSplitterError('Aggregator already finalized');
    }
    for (const [index, buffer] of this.buffers.entries()) {
      if (buffer.length > 0) {
        this.flushBuffer(index, buffer);
      }
    }
    this.closed = true;
    return {
      shards: Array.from(this.shardMap.values()),
      userMeta: new Map(this.userMeta),
      groupDeltas: new Map(this.groupDeltas),
      globalDeltas: [...this.globalDeltas],
      userCounts: new Map(this.userCounts)
    };
  }

  async waitForFlush(): Promise<void> {
    await Promise.all(this.pendingWrites);
  }

  async cleanup(): Promise<void> {
    await this.waitForFlush();
    await fsPromises.rm(this.cleanupRoot, { recursive: true, force: true });
  }

  private ensureBuffer(index: number): string[] {
    const existing = this.buffers.get(index);
    if (existing) {
      return existing;
    }
    const buffer: string[] = [];
    this.buffers.set(index, buffer);
    return buffer;
  }

  private ensureShard(index: number): ShardFileInfo {
    const existing = this.shardMap.get(index);
    if (existing) {
      return existing;
    }
    const filePath = path.join(this.baseDir, `shard-${index}.txt`);
    const shard: ShardFileInfo = { id: index, path: filePath, count: 0 };
    this.shardMap.set(index, shard);
    return shard;
  }

  private flushBuffer(index: number, buffer: string[]): void {
    if (buffer.length === 0) {
      return;
    }
    const shard = this.ensureShard(index);
    const chunk = buffer.join('');
    const appended = buffer.length;
    buffer.length = 0;
    const writePromise = fsPromises
      .appendFile(shard.path, chunk, { encoding: 'utf8' })
      .then(() => {
        shard.count += appended;
      });
    this.pendingWrites.push(writePromise);
  }

  private computeShardIndex(uid: string): number {
    let hash = 0;
    for (let i = 0; i < uid.length; i += 1) {
      hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
    }
    return hash % this.shardCount;
  }
}

function resolveModuleFilename(): string {
  if (typeof __filename === 'string' && __filename.length > 0) {
    return __filename;
  }
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return fileURLToPath(import.meta.url);
  }
  throw new SessionSplitterError('Failed to resolve module filename for worker execution');
}

interface ThresholdWorkerData {
  kind: 'threshold-shard';
  shardPath: string;
  minimumSamples: number;
  fallbackPercentile: number;
  kneeOptions: NormalizedKneeOptions;
}

interface ThresholdWorkerResultMessage {
  kind: 'threshold-shard-result';
  payload: Record<string, WorkerUserSummary>;
}

interface ThresholdWorkerErrorMessage {
  kind: 'threshold-shard-error';
  message: string;
  stack?: string;
}

async function processShardsWithWorkers(
  shards: ShardFileInfo[],
  options: {
    concurrency: number;
    minimumSamples: number;
    fallbackPercentile: number;
    kneeOptions: NormalizedKneeOptions;
  }
): Promise<Map<string, WorkerUserSummary>> {
  const results = new Map<string, WorkerUserSummary>();
  if (shards.length === 0) {
    return results;
  }

  const workerScript = resolveModuleFilename();

  const queue = shards.slice();
  const active = new Set<Promise<void>>();
  const maxWorkers = Math.max(1, Math.min(options.concurrency, shards.length));

  const spawn = (): void => {
    if (queue.length === 0) {
      return;
    }
    const shard = queue.shift();
    if (!shard) {
      return;
    }
    const promise = runShardWorker(workerScript, {
      kind: 'threshold-shard',
      shardPath: shard.path,
      minimumSamples: options.minimumSamples,
      fallbackPercentile: options.fallbackPercentile,
      kneeOptions: options.kneeOptions
    }).then((map) => {
      for (const [uid, summary] of map.entries()) {
        results.set(uid, summary);
      }
    }).finally(() => {
      active.delete(promise);
      spawn();
    });
    active.add(promise);
  };

  for (let i = 0; i < maxWorkers; i += 1) {
    spawn();
  }

  while (active.size > 0) {
    await Promise.race(active);
  }

  return results;
}

function runShardWorker(workerScript: string, data: ThresholdWorkerData): Promise<Map<string, WorkerUserSummary>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, { workerData: data });

    const handleMessage = (message: unknown): void => {
      const payload = message as ThresholdWorkerResultMessage | ThresholdWorkerErrorMessage | undefined;
      if (!payload) {
        return;
      }
      if (payload.kind === 'threshold-shard-result') {
        const entries = Object.entries(payload.payload ?? {});
        resolve(new Map(entries));
        worker.removeListener('message', handleMessage);
        return;
      }
      if (payload.kind === 'threshold-shard-error') {
        const error = new SessionSplitterError(payload.message);
        if (payload.stack) {
          error.stack = payload.stack;
        }
        worker.removeListener('message', handleMessage);
        reject(error);
      }
    };

    worker.on('message', handleMessage);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new SessionSplitterError(`Worker exited with code ${code}`));
      }
    });
  });
}

interface ThresholdDetailBase {
  fd_bins: number;
  tau_otsu: number | null;
  tau_knee: number | null;
  tau_final: number;
  DeltaT: number;
  bimodality_test: number | null;
}

function normalizeBackoffOptions(backoff?: boolean | ThresholdBackoffOptions): NormalizedBackoffOptions {
  if (typeof backoff === "undefined") {
    return {
      enabled: false,
      resolve: () => null,
      describe: () => "group"
    };
  }

  if (backoff === false) {
    return {
      enabled: false,
      resolve: () => null,
      describe: () => "group"
    };
  }

  const normalizeGroupValue = (value: unknown, fallback: string): string => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    return fallback;
  };

  if (backoff === true) {
    const column = DEFAULT_BACKOFF_COLUMN;
    const fallback = DEFAULT_BACKOFF_UNKNOWN;
    return {
      enabled: true,
      resolve: (row: AugmentedRow) => normalizeGroupValue(row.original?.[column], fallback),
      describe: (group: string | null) => `group:${column}=${normalizeGroupValue(group, fallback)}`
    };
  }

  const fallback = normalizeGroupValue(backoff.defaultGroup, DEFAULT_BACKOFF_UNKNOWN);
  const labelCandidate = typeof backoff.label === "string" && backoff.label.trim().length > 0 ? backoff.label.trim() : undefined;

  if (typeof backoff.groupKey === "function") {
    const fn = backoff.groupKey;
    const label = labelCandidate ?? "backoff";
    return {
      enabled: true,
      resolve: (row: AugmentedRow) => normalizeGroupValue(fn(row), fallback),
      describe: (group: string | null) => `group:${label}=${normalizeGroupValue(group, fallback)}`
    };
  }

  const column = typeof backoff.groupKey === "string" && backoff.groupKey.trim().length > 0
    ? backoff.groupKey.trim()
    : DEFAULT_BACKOFF_COLUMN;
  const label = labelCandidate ?? column;

  return {
    enabled: true,
    resolve: (row: AugmentedRow) => normalizeGroupValue(row.original?.[column], fallback),
    describe: (group: string | null) => `group:${label}=${normalizeGroupValue(group, fallback)}`
  };
}

function computeThresholdFromSorted(
  sorted: number[],
  minimumSamples: number,
  fallbackPercentile: number,
  kneeOptions: NormalizedKneeOptions
): { threshold: number; detail: ThresholdDetailBase } {
  if (sorted.length === 0) {
    const safeThreshold = Number.MIN_VALUE;
    return {
      threshold: safeThreshold,
      detail: {
        fd_bins: 0,
        tau_otsu: null,
        tau_knee: null,
        tau_final: Math.log(safeThreshold),
        DeltaT: safeThreshold,
        bimodality_test: null
      }
    };
  }

  if (sorted.length < minimumSamples) {
    const threshold = percentile(sorted, fallbackPercentile);
    const safeThreshold = Math.max(threshold, Number.MIN_VALUE);
    return {
      threshold,
      detail: {
        fd_bins: 0,
        tau_otsu: null,
        tau_knee: null,
        tau_final: Math.log(safeThreshold),
        DeltaT: threshold,
        bimodality_test: null
      }
    };
  }

  const histogram = makeLogHistogram(sorted);
  const { tauLog, quality } = otsuThreshold(histogram);
  const logValues = sorted.map((value) => Math.log(value));
  const { bicDifference } = bimodalityTest(logValues);
  const otsu = otsuThresholdOnSorted(sorted);
  const sigmaLog = computeLogStandardDeviation(sorted);
  const kneedle = kneeThreshold(sorted, tauLog, sigmaLog, kneeOptions);
  const quantile = percentile(sorted, fallbackPercentile);
  const shouldUseKnee = bicDifference <= 0 || quality < LOG_OTSU_QUALITY_MIN;
  const threshold = shouldUseKnee ? Math.max(kneedle, quantile) : Math.max(otsu, kneedle, quantile);
  const safeThreshold = Math.max(threshold, Number.MIN_VALUE);
  const tauOtsu = Number.isFinite(tauLog) ? tauLog : null;
  const tauKnee = kneedle > 0 && Number.isFinite(kneedle) ? Math.log(kneedle) : null;
  const tauFinal = Math.log(safeThreshold);
  const bic = Number.isFinite(bicDifference) ? bicDifference : null;

  return {
    threshold,
    detail: {
      fd_bins: histogram.binCount,
      tau_otsu: tauOtsu,
      tau_knee: tauKnee,
      tau_final: tauFinal,
      DeltaT: threshold,
      bimodality_test: bic
    }
  };
}

async function estimateThresholdsInternal(
  rows: Iterable<AugmentedRow>,
  options: ThresholdEstimationOptions = {}
): Promise<ThresholdComputationResult> {
  const {
    minimumSamples = 5,
    fallbackPercentile = 0.95,
    knee,
    min_events: minEventsSnake,
    minEvents: minEventsCamel,
    backoff,
    concurrency,
    shard_dir: shardDir
  } = options;

  const minEventsCandidate = Number.isFinite(minEventsSnake ?? Number.NaN)
    ? Number(minEventsSnake)
    : Number(minEventsCamel ?? Number.NaN);
  let minEvents = Math.floor(Number.isFinite(minEventsCandidate) ? minEventsCandidate : DEFAULT_MIN_EVENTS);
  if (!(minEvents > 0)) {
    minEvents = DEFAULT_MIN_EVENTS;
  }

  const cpuCount = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : 1;
  const requestedConcurrency = Math.floor(Number.isFinite(concurrency ?? Number.NaN) ? Number(concurrency) : NaN);
  const normalizedConcurrency = requestedConcurrency > 0 ? Math.min(requestedConcurrency, cpuCount) : cpuCount;

  const aggregator = await UserShardAggregator.create(normalizedConcurrency, shardDir);
  const backoffOptions = normalizeBackoffOptions(backoff);

  try {
    for (const row of rows) {
      const groupKey = backoffOptions.enabled ? backoffOptions.resolve(row) : null;
      aggregator.registerUser(row.uid, groupKey);
      if (row.deltaSeconds === null || !Number.isFinite(row.deltaSeconds)) {
        continue;
      }
      if (row.deltaSeconds <= 0) {
        continue;
      }
      aggregator.addDelta(row.uid, row.deltaSeconds, groupKey);
    }

    const aggregationResult = aggregator.finalize();
    await aggregator.waitForFlush();

    const kneeOptions = normalizeKneeOptions(knee);
    const shardsForWorkers = aggregationResult.shards.filter((info) => info.count > 0);
    const userSummaries = await processShardsWithWorkers(shardsForWorkers, {
      concurrency: normalizedConcurrency,
      minimumSamples,
      fallbackPercentile,
      kneeOptions
    });

    const thresholds = new Map<string, number>() as ThresholdMap;
    Object.defineProperty(thresholds, "algo_ver", {
      value: algoVersion,
      enumerable: true,
      configurable: false,
      writable: false
    });

    const details = new Map<string, ThresholdDetail>();
    const cache = new Map<string, { threshold: number; detail: ThresholdDetailBase }>();
    const sortedCache = new Map<string, number[]>();

    const computeWithCache = (key: string, source: number[]): { threshold: number; detail: ThresholdDetailBase } => {
      const existing = cache.get(key);
      if (existing) {
        return existing;
      }
      let sorted = sortedCache.get(key);
      if (!sorted) {
        sorted = source.slice().sort((a, b) => a - b);
        sortedCache.set(key, sorted);
      }
      const result = computeThresholdFromSorted(sorted, minimumSamples, fallbackPercentile, kneeOptions);
      cache.set(key, result);
      return result;
    };

    const globalKey = "__global__";
    const globalSource = aggregationResult.globalDeltas;

    for (const [uid, groupKey] of aggregationResult.userMeta.entries()) {
      const userSummary = userSummaries.get(uid);
      const userCount = aggregationResult.userCounts.get(uid) ?? 0;
      const userKey = `user:${uid}`;

      if (userSummary && userCount >= minEvents) {
        thresholds.set(uid, userSummary.threshold);
        details.set(uid, { ...userSummary.detail, backoff_level: "user" });
        continue;
      }

      let selectedThreshold: number;
      let selectedDetail: ThresholdDetailBase;
      if (userSummary) {
        selectedThreshold = userSummary.threshold;
        selectedDetail = userSummary.detail;
      } else {
        const computed = computeWithCache(userKey, []);
        selectedThreshold = computed.threshold;
        selectedDetail = computed.detail;
      }

      let backoffLevel = "user";

      if (userCount < minEvents) {
        if (backoffOptions.enabled) {
          if (groupKey !== null) {
            const groupSource = aggregationResult.groupDeltas.get(groupKey) ?? [];
            if (groupSource.length >= minEvents) {
              const groupResult = computeWithCache(`group:${groupKey}`, groupSource);
              selectedThreshold = groupResult.threshold;
              selectedDetail = groupResult.detail;
              backoffLevel = backoffOptions.describe(groupKey);
            } else if (globalSource.length >= minEvents) {
              const globalResult = computeWithCache(globalKey, globalSource);
              selectedThreshold = globalResult.threshold;
              selectedDetail = globalResult.detail;
              backoffLevel = "global";
            } else if (groupSource.length > 0) {
              const groupResult = computeWithCache(`group:${groupKey}`, groupSource);
              selectedThreshold = groupResult.threshold;
              selectedDetail = groupResult.detail;
              backoffLevel = backoffOptions.describe(groupKey);
            } else if (globalSource.length > 0) {
              const globalResult = computeWithCache(globalKey, globalSource);
              selectedThreshold = globalResult.threshold;
              selectedDetail = globalResult.detail;
              backoffLevel = "global";
            }
          } else if (globalSource.length > 0) {
            const globalResult = computeWithCache(globalKey, globalSource);
            selectedThreshold = globalResult.threshold;
            selectedDetail = globalResult.detail;
            backoffLevel = "global";
          }
        } else if (globalSource.length > 0) {
          const globalResult = computeWithCache(globalKey, globalSource);
          selectedThreshold = globalResult.threshold;
          selectedDetail = globalResult.detail;
          backoffLevel = "global";
        }
      }

      thresholds.set(uid, selectedThreshold);
      details.set(uid, { ...selectedDetail, backoff_level: backoffLevel });
    }

    return { thresholds, perUser: details, k: kneeOptions.kSigma, scan_step: kneeOptions.logStep };
  } finally {
    await aggregator.cleanup();
  }
}

export async function estimateThresholdsWithMeta(
  rows: Iterable<AugmentedRow>,
  options: ThresholdEstimationOptions = {}
): Promise<ThresholdComputationResult> {
  return estimateThresholdsInternal(rows, options);
}

export async function estimateThresholdsByUser(
  rows: Iterable<AugmentedRow>,
  options: ThresholdEstimationOptions = {}
): Promise<ThresholdMap> {
  const result = await estimateThresholdsInternal(rows, options);
  return result.thresholds;
}

export function makeLogHistogram(
  userLogDeltas: Iterable<number>,
  options: LogHistogramOptions = {}
): LogHistogramResult {
  const normalized = normalizeLogHistogramOptions(options);
  const values = collectPositiveFinite(userLogDeltas);
  if (values.length === 0) {
    return {
      binEdges: [],
      binCounts: [],
      binCount: 0,
      logBinWidth: 0,
      domain: { min: Number.NaN, max: Number.NaN, logMin: Number.NaN, logMax: Number.NaN }
    };
  }

  values.sort((a, b) => a - b);
  const rawMin = values[0];
  const rawMax = values[values.length - 1];
  const roundedMin = roundMinBoundary(rawMin, normalized.decimals);
  const roundedMax = roundMaxBoundary(rawMax, normalized.decimals);

  const logValues = values.map((value) => logWithBase(value, normalized.logBase)).sort((a, b) => a - b);
  const effectiveMin = roundedMin > 0 ? roundedMin : rawMin;
  const logMin = logWithBase(effectiveMin, normalized.logBase);
  const logMax = logWithBase(roundedMax, normalized.logBase);

  if (!Number.isFinite(logMin) || !Number.isFinite(logMax) || logMax <= logMin) {
    const singleEdgeMin = effectiveMin;
    const singleEdgeMax = roundedMax;
    return {
      binEdges: [singleEdgeMin, singleEdgeMax],
      binCounts: [values.length],
      binCount: 1,
      logBinWidth: 0,
      domain: { min: singleEdgeMin, max: singleEdgeMax, logMin, logMax }
    };
  }

  const layout = computeFreedmanLayout(logValues, logMin, logMax, normalized);
  const binEdges = buildLogEdges(logMin, layout.logBinWidth, layout.binCount, normalized, effectiveMin, roundedMax);
  const binCounts = computeHistogramCounts(values, binEdges);

  return {
    binEdges,
    binCounts,
    binCount: layout.binCount,
    logBinWidth: layout.logBinWidth,
    domain: {
      min: binEdges[0],
      max: binEdges[binEdges.length - 1],
      logMin,
      logMax
    }
  };
}

export function otsuThreshold(logHistogram: LogHistogramResult): LogOtsuThresholdResult {
  const { binCounts, binCount, logBinWidth, domain } = logHistogram;
  if (binCount <= 0 || binCounts.length === 0) {
    return { tauLog: Number.NaN, quality: 0 };
  }
  if (!Number.isFinite(domain.logMin) || !Number.isFinite(domain.logMax)) {
    return { tauLog: Number.NaN, quality: 0 };
  }
  if (!(logBinWidth > 0) || !Number.isFinite(logBinWidth)) {
    const tau = clampFinite(domain.logMin, domain.logMin, domain.logMax);
    return { tauLog: tau, quality: 0 };
  }

  let total = 0;
  for (const count of binCounts) {
    total += count;
  }
  if (!(total > 0)) {
    const tau = clampFinite(domain.logMin, domain.logMin, domain.logMax);
    return { tauLog: tau, quality: 0 };
  }

  const centers = new Array<number>(binCount);
  let sumAll = 0;
  let sumSqAll = 0;
  for (let i = 0; i < binCount; i += 1) {
    const center = domain.logMin + logBinWidth * (i + 0.5);
    centers[i] = center;
    const count = binCounts[i] ?? 0;
    if (count > 0) {
      sumAll += count * center;
      sumSqAll += count * center * center;
    }
  }

  const totalMean = sumAll / total;
  const rawVariance = sumSqAll / total - totalMean * totalMean;
  const totalVariance = Number.isFinite(rawVariance) && rawVariance > 0 ? rawVariance : 0;

  let cumulativeCount = 0;
  let cumulativeSum = 0;
  let bestBetween = -Infinity;
  let bestTau = clampFinite(domain.logMin, domain.logMin, domain.logMax);
  let bestQuality = 0;

  for (let i = 0; i < binCount - 1; i += 1) {
    const count = binCounts[i] ?? 0;
    cumulativeCount += count;
    cumulativeSum += count * centers[i];
    if (!(cumulativeCount > 0)) {
      continue;
    }
    const foreground = total - cumulativeCount;
    if (!(foreground > 0)) {
      break;
    }

    const omegaBackground = cumulativeCount / total;
    const omegaForeground = foreground / total;
    const muBackground = cumulativeSum / cumulativeCount;
    const muForeground = (sumAll - cumulativeSum) / foreground;
    const betweenVariance = omegaBackground * omegaForeground * (muBackground - muForeground) ** 2;

    if (betweenVariance > bestBetween) {
      bestBetween = betweenVariance;
      const candidate = domain.logMin + logBinWidth * (i + 1);
      bestTau = clampFinite(candidate, domain.logMin, domain.logMax);
      if (totalVariance > 0) {
        const ratio = betweenVariance / totalVariance;
        bestQuality = Number.isFinite(ratio) && ratio >= 0 ? ratio : 0;
      } else {
        bestQuality = 0;
      }
    }
  }

  if (!(bestBetween > 0) || !Number.isFinite(bestTau)) {
    bestTau = clampFinite(domain.logMin, domain.logMin, domain.logMax);
    bestQuality = 0;
  }

  return { tauLog: bestTau, quality: bestQuality };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  const position = clampedFraction * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return values[lowerIndex];
  }
  const weight = position - lowerIndex;
  return values[lowerIndex] * (1 - weight) + values[upperIndex] * weight;
}

function otsuThresholdOnSorted(sortedValues: number[]): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const min = sortedValues[0];
  const max = sortedValues[sortedValues.length - 1];
  if (min === max) {
    return max;
  }
  const binCount = Math.min(256, Math.max(2, Math.floor(Math.sqrt(sortedValues.length))));
  const histogram = new Array<number>(binCount).fill(0);
  const range = max - min;
  const binWidth = range === 0 ? 1 : range / binCount;

  for (const value of sortedValues) {
    const index = range === 0 ? 0 : Math.min(binCount - 1, Math.floor((value - min) / binWidth));
    histogram[index] += 1;
  }

  const total = sortedValues.length;
  let sumAll = 0;
  for (let i = 0; i < binCount; i += 1) {
    const center = min + (i + 0.5) * binWidth;
    sumAll += histogram[i] * center;
  }

  let sumB = 0;
  let wB = 0;
  let maxVariance = -Infinity;
  let threshold = min;

  for (let i = 0; i < binCount; i += 1) {
    wB += histogram[i];
    if (wB === 0) {
      continue;
    }
    const wF = total - wB;
    if (wF === 0) {
      break;
    }
    const center = min + (i + 0.5) * binWidth;
    sumB += histogram[i] * center;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const variance = wB * wF * (mB - mF) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = center;
    }
  }

  return threshold;
}

interface NormalizedKneeOptions {
  logStep: number;
  kSigma: number;
  smoothingWindow: number;
  minCandidates: number;
}

function normalizeKneeOptions(options: KneeDetectionOptions = {}): NormalizedKneeOptions {
  const logStepCandidate = typeof options.logStep === "number" ? options.logStep : Number.NaN;
  const kSigmaCandidate = typeof options.kSigma === "number" ? options.kSigma : Number.NaN;
  const smoothingCandidate = typeof options.smoothingWindow === "number" ? options.smoothingWindow : Number.NaN;
  const minCandidatesCandidate = typeof options.minCandidates === "number" ? options.minCandidates : Number.NaN;

  const logStep = Number.isFinite(logStepCandidate) && logStepCandidate > 0 ? logStepCandidate : 0.05;
  const kSigma = Number.isFinite(kSigmaCandidate) && kSigmaCandidate >= 0 ? kSigmaCandidate : 2;

  let smoothingWindow = Number.isFinite(smoothingCandidate) ? Math.floor(smoothingCandidate) : 3;
  if (smoothingWindow < 1) {
    smoothingWindow = 1;
  }
  if (smoothingWindow > 5) {
    smoothingWindow = 5;
  }
  if (smoothingWindow % 2 === 0) {
    smoothingWindow += smoothingWindow === 5 ? -1 : 1;
  }

  const minCandidates = Number.isFinite(minCandidatesCandidate) && minCandidatesCandidate > 0 ? Math.floor(minCandidatesCandidate) : 16;

  return { logStep, kSigma, smoothingWindow, minCandidates };
}

function buildCandidateLogThresholds(
  sortedValues: number[],
  tauLog: number,
  sigmaLog: number,
  options: NormalizedKneeOptions
): number[] {
  if (sortedValues.length === 0) {
    return [];
  }

  const logMinData = Math.log(sortedValues[0]);
  const logMaxData = Math.log(sortedValues[sortedValues.length - 1]);

  const tauCenter = Number.isFinite(tauLog) ? tauLog : (logMinData + logMaxData) / 2;
  const sigma = Number.isFinite(sigmaLog) && sigmaLog > 0 ? sigmaLog : Math.max(0, logMaxData - logMinData) / 6;
  const span = options.kSigma * sigma;

  let start = tauCenter - span;
  let end = tauCenter + span;
  if (!(end > start)) {
    start = tauCenter - options.logStep;
    end = tauCenter + options.logStep;
  }

  start = Math.max(logMinData, start);
  end = Math.min(logMaxData, end);

  if (!(end > start)) {
    if (logMaxData > logMinData) {
      start = logMinData;
      end = logMaxData;
    } else {
      return [logMinData];
    }
  }

  const spanLog = end - start;
  if (!(spanLog > 0)) {
    return [start];
  }

  const desiredCount = Math.max(2, options.minCandidates);
  let effectiveStep = options.logStep;
  const impliedCount = Math.floor(spanLog / effectiveStep) + 1;
  if (impliedCount < desiredCount) {
    effectiveStep = spanLog / (desiredCount - 1);
  }
  if (!(effectiveStep > 0)) {
    effectiveStep = spanLog / (desiredCount - 1);
  }

  const candidates: number[] = [];
  for (let cursor = start; cursor <= end + effectiveStep * 0.5; cursor += effectiveStep) {
    candidates.push(cursor);
  }
  if (candidates.length === 0) {
    return [start];
  }
  const lastIndex = candidates.length - 1;
  candidates[lastIndex] = end;
  return candidates;
}

function upperBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function computeSessionCounts(sortedValues: number[], thresholds: number[]): number[] {
  const result = new Array<number>(thresholds.length);
  for (let i = 0; i < thresholds.length; i += 1) {
    const tau = thresholds[i];
    const index = upperBound(sortedValues, tau);
    const count = sortedValues.length - index;
    result[i] = count + 1;
  }
  return result;
}

function movingAverage(values: number[], window: number): number[] {
  if (window <= 1 || values.length === 0) {
    return [...values];
  }
  const half = Math.floor(window / 2);
  const prefix = new Array<number>(values.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < values.length; i += 1) {
    prefix[i + 1] = prefix[i] + values[i];
  }
  const smoothed = new Array<number>(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    const sum = prefix[end + 1] - prefix[start];
    smoothed[i] = sum / (end - start + 1);
  }
  return smoothed;
}

function computeKneeDistance(logCandidates: number[], counts: number[]): number {
  if (logCandidates.length === 0) {
    return 0;
  }
  const minLog = logCandidates[0];
  const maxLog = logCandidates[logCandidates.length - 1];
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const denomX = maxLog - minLog;
  const denomY = maxCount - minCount;
  if (!(denomX > 0) || !(denomY > 0)) {
    return Math.exp(logCandidates[Math.floor(logCandidates.length / 2)]);
  }
  let bestIndex = 0;
  let bestDistance = -Infinity;
  for (let i = 0; i < logCandidates.length; i += 1) {
    const xNorm = (logCandidates[i] - minLog) / denomX;
    const yNorm = (counts[i] - minCount) / denomY;
    const distance = Math.abs(yNorm + xNorm - 1) / Math.SQRT2;
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return Math.exp(logCandidates[bestIndex]);
}

export function kneeThreshold(
  userRows: Iterable<number>,
  tauLog: number,
  sigmaLog: number,
  options: KneeDetectionOptions = {}
): number {
  const values = collectPositiveFinite(userRows);
  if (values.length === 0) {
    return 0;
  }
  values.sort((a, b) => a - b);
  const normalizedOptions = normalizeKneeOptions(options);
  const logCandidates = buildCandidateLogThresholds(values, tauLog, sigmaLog, normalizedOptions);
  if (logCandidates.length === 0) {
    return values[values.length - 1];
  }
  const thresholds = logCandidates.map((candidate) => Math.exp(candidate));
  const counts = computeSessionCounts(values, thresholds);
  const smoothed = normalizedOptions.smoothingWindow > 1 ? movingAverage(counts, normalizedOptions.smoothingWindow) : counts;
  return computeKneeDistance(logCandidates, smoothed);
}

export function computeKneeCurve(
  userRows: Iterable<number>,
  tauLog: number,
  sigmaLog: number,
  options: KneeDetectionOptions = {}
): KneeCurve {
  const values = collectPositiveFinite(userRows);
  if (values.length === 0) {
    return {
      points: [],
      knee: {
        threshold: 0,
        logThreshold: Number.NaN
      }
    };
  }

  values.sort((a, b) => a - b);
  const normalizedOptions = normalizeKneeOptions(options);
  const logCandidates = buildCandidateLogThresholds(values, tauLog, sigmaLog, normalizedOptions);

  if (logCandidates.length === 0) {
    const last = values[values.length - 1];
    return {
      points: [
        {
          threshold: last,
          logThreshold: Math.log(last),
          count: 1,
          smoothed: 1
        }
      ],
      knee: {
        threshold: last,
        logThreshold: Math.log(last)
      }
    };
  }

  const thresholds = logCandidates.map((candidate) => Math.exp(candidate));
  const counts = computeSessionCounts(values, thresholds);
  const smoothed =
    normalizedOptions.smoothingWindow > 1 ? movingAverage(counts, normalizedOptions.smoothingWindow) : counts;

  const points: KneeCurvePoint[] = thresholds.map((threshold, index) => ({
    threshold,
    logThreshold: logCandidates[index],
    count: counts[index],
    smoothed: smoothed[index]
  }));

  const kneeThresholdValue = computeKneeDistance(logCandidates, smoothed);
  const kneeLog = kneeThresholdValue > 0 && Number.isFinite(kneeThresholdValue) ? Math.log(kneeThresholdValue) : Number.NaN;

  return {
    points,
    knee: {
      threshold: kneeThresholdValue,
      logThreshold: kneeLog
    }
  };
}

function computeLogStandardDeviation(values: number[]): number {
  const logs: number[] = [];
  for (const value of values) {
    if (typeof value !== "number") {
      continue;
    }
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    logs.push(Math.log(value));
  }
  if (logs.length === 0) {
    return 0;
  }
  const { variance } = computeMeanAndVariance(logs);
  return variance > 0 && Number.isFinite(variance) ? Math.sqrt(variance) : 0;
}

export function bimodalityTest(logValuesInput: Iterable<number>): BimodalityTestResult {
  const logValues: number[] = [];
  for (const value of logValuesInput) {
    if (typeof value !== "number") {
      continue;
    }
    if (!Number.isFinite(value)) {
      continue;
    }
    logValues.push(value);
  }
  if (logValues.length < MIN_BIMODAL_SAMPLES) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }
  logValues.sort((a, b) => a - b);

  const { mean: singleMean, variance: singleVariance } = computeMeanAndVariance(logValues);
  if (!(singleVariance > 0) || !Number.isFinite(singleVariance)) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }

  const logLikelihoodSingle = gaussianLogLikelihood(logValues, singleMean, singleVariance);
  if (!Number.isFinite(logLikelihoodSingle)) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }

  const mixture = fitTwoComponentGaussian(logValues, singleMean, singleVariance);
  if (!mixture) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }

  const pooledVariance = (mixture.variance1 + mixture.variance2) / 2;
  const pooledStd = Math.sqrt(Math.max(MIN_VARIANCE, pooledVariance));
  const separation = Math.abs(mixture.mean1 - mixture.mean2);
  const singleStd = Math.sqrt(Math.max(MIN_VARIANCE, singleVariance));
  if (
    !(pooledStd > 0) ||
    !(singleStd > 0) ||
    separation < pooledStd * 0.75 ||
    separation < singleStd * 0.75
  ) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }

  const logLikelihoodDouble = gaussianMixtureLogLikelihood(logValues, mixture);
  if (!Number.isFinite(logLikelihoodDouble)) {
    return { bicDifference: Number.NEGATIVE_INFINITY };
  }

  const n = logValues.length;
  const bicSingle = -2 * logLikelihoodSingle + 2 * Math.log(n);
  const bicDouble = -2 * logLikelihoodDouble + 5 * Math.log(n);
  const rawDifference = bicSingle - bicDouble;
  const bicDifference = Number.isFinite(rawDifference) ? rawDifference : Number.NEGATIVE_INFINITY;
  return { bicDifference };
}

interface GaussianMixtureParams {
  weight1: number;
  weight2: number;
  mean1: number;
  mean2: number;
  variance1: number;
  variance2: number;
}

function computeMeanAndVariance(values: number[]): { mean: number; variance: number } {
  const n = values.length;
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  const mean = sum / n;
  let sumSq = 0;
  for (const value of values) {
    const diff = value - mean;
    sumSq += diff * diff;
  }
  const variance = Math.max(MIN_VARIANCE, sumSq / n);
  return { mean, variance };
}

function gaussianLogPdf(value: number, mean: number, variance: number): number {
  const clampedVariance = Math.max(MIN_VARIANCE, variance);
  return -0.5 * (Math.log(2 * Math.PI * clampedVariance) + ((value - mean) ** 2) / clampedVariance);
}

function gaussianLogLikelihood(values: number[], mean: number, variance: number): number {
  const clampedVariance = Math.max(MIN_VARIANCE, variance);
  let sum = 0;
  for (const value of values) {
    sum += gaussianLogPdf(value, mean, clampedVariance);
  }
  return sum;
}

function fitTwoComponentGaussian(
  sortedValues: number[],
  initialMean: number,
  initialVariance: number
): GaussianMixtureParams | null {
  const n = sortedValues.length;
  let mean1 = sortedValues[Math.max(0, Math.floor(n / 3) - 1)];
  let mean2 = sortedValues[Math.min(n - 1, Math.floor((2 * n) / 3))];
  if (mean1 === mean2) {
    mean1 = sortedValues[Math.max(0, Math.floor(n / 4))];
    mean2 = sortedValues[Math.min(n - 1, Math.floor((3 * n) / 4))];
    if (mean1 === mean2) {
      mean1 -= 1e-3;
      mean2 += 1e-3;
    }
  }
  let variance1 = Math.max(MIN_VARIANCE, initialVariance);
  let variance2 = Math.max(MIN_VARIANCE, initialVariance);
  let weight1 = 0.5;
  let weight2 = 0.5;

  for (let iteration = 0; iteration < EM_MAX_ITERATIONS; iteration += 1) {
    let sumGamma1 = 0;
    let sumGamma2 = 0;
    let meanNumerator1 = 0;
    let meanNumerator2 = 0;
    let maxParameterShift = 0;
    const responsibilities: number[] = new Array(sortedValues.length);

    for (let index = 0; index < sortedValues.length; index += 1) {
      const value = sortedValues[index];
      const logP1 = Math.log(weight1) + gaussianLogPdf(value, mean1, variance1);
      const logP2 = Math.log(weight2) + gaussianLogPdf(value, mean2, variance2);
      const maxLog = Math.max(logP1, logP2);
      const exp1 = Math.exp(logP1 - maxLog);
      const exp2 = Math.exp(logP2 - maxLog);
      const denom = exp1 + exp2;
      const responsibility1 = denom === 0 ? 0.5 : exp1 / denom;
      const responsibility2 = 1 - responsibility1;

      sumGamma1 += responsibility1;
      sumGamma2 += responsibility2;
      meanNumerator1 += responsibility1 * value;
      meanNumerator2 += responsibility2 * value;
      responsibilities[index] = responsibility1;
    }

    if (!(sumGamma1 > 0) || !(sumGamma2 > 0)) {
      return null;
    }

    const newWeight1 = Math.min(1 - MIN_COMPONENT_WEIGHT, Math.max(MIN_COMPONENT_WEIGHT, sumGamma1 / n));
    const newWeight2 = 1 - newWeight1;

    const newMean1 = meanNumerator1 / sumGamma1;
    const newMean2 = meanNumerator2 / sumGamma2;

    let varianceNumerator1 = 0;
    let varianceNumerator2 = 0;
    for (let index = 0; index < sortedValues.length; index += 1) {
      const value = sortedValues[index];
      const responsibility1 = responsibilities[index];
      const responsibility2 = 1 - responsibility1;
      const diff1 = value - newMean1;
      const diff2 = value - newMean2;
      varianceNumerator1 += responsibility1 * diff1 * diff1;
      varianceNumerator2 += responsibility2 * diff2 * diff2;
    }

    const newVariance1 = Math.max(MIN_VARIANCE, varianceNumerator1 / sumGamma1);
    const newVariance2 = Math.max(MIN_VARIANCE, varianceNumerator2 / sumGamma2);

    maxParameterShift = Math.max(
      Math.abs(newWeight1 - weight1),
      Math.abs(newMean1 - mean1),
      Math.abs(newMean2 - mean2),
      Math.abs(newVariance1 - variance1),
      Math.abs(newVariance2 - variance2)
    );

    weight1 = newWeight1;
    weight2 = newWeight2;
    mean1 = newMean1;
    mean2 = newMean2;
    variance1 = newVariance1;
    variance2 = newVariance2;

    if (maxParameterShift < EM_TOLERANCE) {
      break;
    }
  }

  if (!Number.isFinite(weight1) || !Number.isFinite(weight2)) {
    return null;
  }

  return { weight1, weight2, mean1, mean2, variance1, variance2 };
}

function gaussianMixtureLogLikelihood(values: number[], params: GaussianMixtureParams): number {
  const { weight1, weight2, mean1, mean2, variance1, variance2 } = params;
  if (!(weight1 > 0) || !(weight2 > 0)) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const value of values) {
    const logP1 = Math.log(weight1) + gaussianLogPdf(value, mean1, variance1);
    const logP2 = Math.log(weight2) + gaussianLogPdf(value, mean2, variance2);
    const maxLog = Math.max(logP1, logP2);
    const exp1 = Math.exp(logP1 - maxLog);
    const exp2 = Math.exp(logP2 - maxLog);
    const denom = exp1 + exp2;
    if (denom <= 0 || !Number.isFinite(denom)) {
      return Number.NEGATIVE_INFINITY;
    }
    sum += maxLog + Math.log(denom);
  }
  return sum;
}

function collectPositiveFinite(values: Iterable<number>): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (typeof value !== "number") {
      continue;
    }
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    result.push(value);
  }
  return result;
}

function computeFreedmanLayout(
  sortedLogValues: number[],
  logMin: number,
  logMax: number,
  options: NormalizedLogHistogramOptions
): { binCount: number; logBinWidth: number } {
  const range = logMax - logMin;
  if (!(range > 0)) {
    return { binCount: 1, logBinWidth: range };
  }
  const q1 = quantileFromSorted(sortedLogValues, 0.25);
  const q3 = quantileFromSorted(sortedLogValues, 0.75);
  const iqr = q3 - q1;
  const n = sortedLogValues.length;
  const denominator = Math.cbrt(n);
  let width = iqr > 0 && Number.isFinite(iqr) && denominator > 0 ? (2 * iqr) / denominator : Number.NaN;
  if (!(width > 0) || !Number.isFinite(width)) {
    width = range / options.maxBinCount;
  }
  let estimated = Math.ceil(range / width);
  if (!Number.isFinite(estimated) || estimated <= 0) {
    estimated = options.maxBinCount;
  }
  const binCount = clampBinCount(estimated, options);
  const logBinWidth = range / binCount;
  return { binCount, logBinWidth };
}

function clampBinCount(value: number, options: NormalizedLogHistogramOptions): number {
  const integer = Math.max(1, Math.floor(value));
  const upper = Math.min(options.maxBinCount, LOG_HISTOGRAM_DEFAULTS.maxBinCount);
  const lower = Math.max(options.minBinCount, LOG_HISTOGRAM_DEFAULTS.minBinCount);
  return Math.min(upper, Math.max(lower, integer));
}

function clampFinite(value: number, boundaryA: number, boundaryB: number): number {
  if (!Number.isFinite(boundaryA) || !Number.isFinite(boundaryB)) {
    return Number.isFinite(value) ? value : 0;
  }
  const lower = Math.min(boundaryA, boundaryB);
  const upper = Math.max(boundaryA, boundaryB);
  if (lower === upper) {
    return lower;
  }
  const finiteValue = Number.isFinite(value) ? value : lower;
  const clamped = Math.min(upper, Math.max(lower, finiteValue));
  return Number.isFinite(clamped) ? clamped : lower;
}

function quantileFromSorted(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  const position = clamped * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function buildLogEdges(
  logMin: number,
  logBinWidth: number,
  binCount: number,
  options: NormalizedLogHistogramOptions,
  minEdge: number,
  maxEdge: number
): number[] {
  const edges = new Array<number>(binCount + 1);
  for (let i = 0; i <= binCount; i += 1) {
    const logValue = logMin + logBinWidth * i;
    edges[i] = powWithBase(logValue, options.logBase);
  }
  const minRounded = roundMinBoundary(minEdge, options.decimals);
  edges[0] = minRounded > 0 ? minRounded : minEdge;
  const minStep = options.decimals > 0 ? 1 / 10 ** options.decimals : Number.EPSILON;
  for (let i = 1; i < edges.length - 1; i += 1) {
    const rounded = roundFixed(edges[i], options.decimals);
    edges[i] = rounded > edges[i - 1] ? rounded : roundFixed(edges[i - 1] + minStep, options.decimals);
  }
  const lastIndex = edges.length - 1;
  const roundedMax = roundMaxBoundary(maxEdge, options.decimals);
  const candidateMax = Math.max(roundedMax, edges[lastIndex - 1] + minStep);
  edges[lastIndex] = roundFixed(candidateMax, options.decimals);
  return edges;
}

function computeHistogramCounts(sortedValues: number[], edges: number[]): number[] {
  if (edges.length <= 1) {
    return sortedValues.length > 0 ? [sortedValues.length] : [];
  }
  const binLength = edges.length - 1;
  const useTypedArray = sortedValues.length > 65_536;
  if (useTypedArray) {
    const counts = new Uint32Array(binLength);
    let index = 0;
    for (const value of sortedValues) {
      while (index < binLength - 1 && value >= edges[index + 1]) {
        index += 1;
      }
      counts[index] += 1;
    }
    return Array.from(counts);
  }
  const counts = new Array<number>(binLength).fill(0);
  let index = 0;
  for (const value of sortedValues) {
    while (index < binLength - 1 && value >= edges[index + 1]) {
      index += 1;
    }
    counts[index] += 1;
  }
  return counts;
}

function roundFixed(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.round(value);
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundMinBoundary(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.floor(value);
  }
  const factor = 10 ** decimals;
  const rounded = Math.floor(value * factor) / factor;
  return rounded > 0 ? rounded : value;
}

function roundMaxBoundary(value: number, decimals: number): number {
  if (decimals <= 0) {
    return Math.ceil(value);
  }
  const factor = 10 ** decimals;
  const rounded = Math.ceil(value * factor) / factor;
  return rounded;
}

function logWithBase(value: number, base: number): number {
  return Math.log(value) / Math.log(base);
}

function powWithBase(exponent: number, base: number): number {
  return base === Math.E ? Math.exp(exponent) : base ** exponent;
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      if (typeof chunk === 'string') {
        hash.update(Buffer.from(chunk));
      } else {
        hash.update(chunk);
      }
    });
    stream.on('error', (error: unknown) => {
      reject(error);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function resolveMetaPath(target: string | URL): string {
  if (target instanceof URL) {
    return fileURLToPath(target);
  }
  return target;
}

export async function writeMeta(metaPath: string | URL, meta: ThresholdMetaInput): Promise<ThresholdMeta> {
  const requiredKeys: Array<keyof ThresholdMetaInput> = [
    'algo_ver',
    'epsilon',
    'ntp_p95_ms',
    'ingress_jitter_ms',
    'fd_bins',
    'tau_otsu',
    'tau_knee',
    'tau_final',
    'DeltaT',
    'bimodality_test',
    'backoff_level',
    'k',
    'scan_step',
    'hkdf_info',
    'kid',
    'datasetPath',
    'thresholds_by_uid'
  ];
  for (const key of requiredKeys) {
    if (!(key in meta)) {
      throw new SessionSplitterError(`meta field \"${String(key)}\" is required to write meta.json`);
    }
  }

  const datasetHash = await computeFileSha256(meta.datasetPath);
  const { datasetPath, ...rest } = meta;
  const payload: ThresholdMeta = { ...rest, dataset_hash: datasetHash };
  const outputPath = resolveMetaPath(metaPath);
  const directory = path.dirname(outputPath);
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
  return payload;
}

function serializeWorkerError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: 'Unknown worker error' };
  }
}

async function runThresholdShard(data: ThresholdWorkerData): Promise<void> {
  const perUser = new Map<string, number[]>();
  const stream = createReadStream(data.shardPath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of reader) {
    if (typeof line !== 'string' || line.length === 0) {
      continue;
    }
    const [uid, deltaRaw] = line.split('\t');
    if (!uid || !deltaRaw) {
      continue;
    }
    const delta = Number.parseFloat(deltaRaw);
    if (!Number.isFinite(delta) || delta <= 0) {
      continue;
    }
    const list = perUser.get(uid);
    if (list) {
      list.push(delta);
    } else {
      perUser.set(uid, [delta]);
    }
  }

  const results: Record<string, WorkerUserSummary> = {};
  for (const [uid, values] of perUser.entries()) {
    values.sort((a, b) => a - b);
    const { threshold, detail } = computeThresholdFromSorted(values, data.minimumSamples, data.fallbackPercentile, data.kneeOptions);
    results[uid] = { threshold, detail, count: values.length };
  }

  parentPort?.postMessage({ kind: 'threshold-shard-result', payload: results });
}

if (!isMainThread && workerData && (workerData as { kind?: string }).kind === 'threshold-shard') {
  const data = workerData as ThresholdWorkerData;
  runThresholdShard(data).catch((error: unknown) => {
    const serialized = serializeWorkerError(error);
    parentPort?.postMessage({ kind: 'threshold-shard-error', message: serialized.message, stack: serialized.stack });
  });
}
