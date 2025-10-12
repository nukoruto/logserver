import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

type AuditOptions = {
  paths: string[];
  failOnError: boolean;
};

type CsvRow = Record<string, string>;

type AuditFinding = {
  file: string;
  line: number;
  message: string;
};

type MetaSummary = {
  DeltaT?: Record<string, number | null>;
  thresholds_by_uid?: Record<string, number | null>;
  tau_final?: Record<string, number | null>;
  tau_otsu?: Record<string, number | null>;
  tau_knee?: Record<string, number | null>;
};

type ThresholdRecord = {
  value: number;
  source: string;
};

type ParsedEvent = {
  line: number;
  sidFinal: string | null;
  deltaSeconds: number | null;
  timestampMs: number | null;
  threshold: number | null;
};

type UidInfo = {
  threshold?: ThresholdRecord;
  method?: MethodChoice;
};

type MethodChoice = 'otsu' | 'knee' | 'other' | 'unknown';

type AuditSummary = {
  files: number;
  rows: number;
  findings: number;
  unknown_time_label_ratio: number | null;
  per_uid_delta_t: Record<string, number>;
  method_usage: Record<MethodChoice, number>;
  sid_final_transition_checks: number;
};

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const OP_CATEGORIES = new Set(['AUTH', 'READ', 'UPDATE']);
const CSV_EXTENSION = '.csv';
const EPSILON = 1e-6;

const parseArgs = (argv: string[]): AuditOptions => {
  const options: AuditOptions = { paths: [], failOnError: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir' || arg === '--path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.paths.push(value);
      index += 1;
    } else if (arg === '--fail-on-error' || arg === '--fail') {
      options.failOnError = true;
    }
  }

  if (options.paths.length === 0) {
    throw new Error('At least one --dir or --path argument is required');
  }
  return options;
};

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
};

const parseCsvContent = (content: string): { header: string[]; rows: CsvRow[] } => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const values = parseCsvLine(lines[index]);
    const record: CsvRow = {};
    header.forEach((column, columnIndex) => {
      record[column] = values[columnIndex] ?? '';
    });
    rows.push(record);
  }

  return { header, rows };
};

const collectCsvFiles = async (inputs: readonly string[]): Promise<string[]> => {
  const results: string[] = [];

  const traverse = async (target: string): Promise<void> => {
    const stats = await stat(target);
    if (stats.isDirectory()) {
      const entries = await readdir(target);
      await Promise.all(entries.map((entry) => traverse(path.join(target, entry))));
      return;
    }
    if (stats.isFile() && target.endsWith(CSV_EXTENSION)) {
      results.push(target);
    }
  };

  for (const input of inputs) {
    await traverse(path.resolve(process.cwd(), input));
  }

  return results;
};

const parseNumber = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
};

const parseTimestampMs = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return time;
};

const approxEqual = (a: number, b: number): boolean => {
  return Math.abs(a - b) <= EPSILON;
};

const safeParseJson = (input: string): Record<string, unknown> | null => {
  if (!input || input.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
};

const loadMetaForDirectory = async (
  directory: string,
  cache: Map<string, MetaSummary | null>,
  findings: AuditFinding[],
  file: string
): Promise<MetaSummary | null> => {
  if (cache.has(directory)) {
    return cache.get(directory) ?? null;
  }

  const candidates = ['meta.json'];
  for (const candidate of candidates) {
    const metaPath = path.join(directory, candidate);
    try {
      const content = await readFile(metaPath, 'utf8');
      const parsed = JSON.parse(content) as MetaSummary;
      cache.set(directory, parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      findings.push({ file, line: 1, message: `Failed to load meta.json: ${(error as Error).message}` });
      cache.set(directory, null);
      return null;
    }
  }

  cache.set(directory, null);
  return null;
};

const extractThresholdFromMeta = (meta: MetaSummary, uid: string): ThresholdRecord | null => {
  if (meta.DeltaT && meta.DeltaT[uid] != null) {
    const value = meta.DeltaT[uid];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, source: 'meta:DeltaT' };
    }
  }
  if (meta.thresholds_by_uid && meta.thresholds_by_uid[uid] != null) {
    const value = meta.thresholds_by_uid[uid];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, source: 'meta:thresholds_by_uid' };
    }
  }
  if (meta.tau_final && meta.tau_final[uid] != null) {
    const tau = meta.tau_final[uid];
    if (typeof tau === 'number' && Number.isFinite(tau)) {
      return { value: Math.exp(tau), source: 'meta:tau_final' };
    }
  }
  return null;
};

const determineMethodFromMeta = (meta: MetaSummary, uid: string): MethodChoice | undefined => {
  if (!meta.tau_final || meta.tau_final[uid] == null) {
    return undefined;
  }
  const tauFinal = meta.tau_final[uid];
  if (typeof tauFinal !== 'number' || !Number.isFinite(tauFinal)) {
    return 'unknown';
  }
  const tauOtsu = meta.tau_otsu ? meta.tau_otsu[uid] : null;
  const tauKnee = meta.tau_knee ? meta.tau_knee[uid] : null;

  if (typeof tauKnee === 'number' && Number.isFinite(tauKnee) && approxEqual(tauFinal, tauKnee)) {
    return 'knee';
  }
  if (typeof tauOtsu === 'number' && Number.isFinite(tauOtsu) && approxEqual(tauFinal, tauOtsu)) {
    return 'otsu';
  }
  return 'other';
};

const resolveThresholdFromRow = (
  row: CsvRow,
  metadata: Record<string, unknown> | null,
  meta: MetaSummary | null,
  uid: string | null
): ThresholdRecord | null => {
  const columnCandidates: Array<{ key: string; source: string }> = [
    { key: 'DeltaT', source: 'row:DeltaT' },
    { key: 'delta_threshold', source: 'row:delta_threshold' },
    { key: 'delta_t_threshold', source: 'row:delta_t_threshold' },
    { key: 'idle_timeout_seconds', source: 'row:idle_timeout_seconds' },
  ];

  for (const candidate of columnCandidates) {
    const numeric = parseNumber(row[candidate.key]);
    if (numeric !== null) {
      return { value: numeric, source: candidate.source };
    }
  }

  if (metadata) {
    const metadataKeys = [
      { key: 'DeltaT', source: 'metadata.DeltaT' },
      { key: 'delta_t_threshold', source: 'metadata.delta_t_threshold' },
      { key: 'idle_timeout_seconds', source: 'metadata.idle_timeout_seconds' },
    ];
    for (const candidate of metadataKeys) {
      if (!Object.prototype.hasOwnProperty.call(metadata, candidate.key)) {
        continue;
      }
      const numeric = parseNumber(metadata[candidate.key]);
      if (numeric !== null) {
        return { value: numeric, source: candidate.source };
      }
    }
  }

  if (meta && uid) {
    return extractThresholdFromMeta(meta, uid);
  }

  return null;
};

const validateRow = (
  row: CsvRow,
  file: string,
  lineNumber: number,
  header: readonly string[],
  findings: AuditFinding[]
): void => {
  const method = row.method || '';
  const timestamp = row.timestamp_utc || row.timestamp || '';
  const category = row.op_category || '';

  if (row.timestamp_utc && !RFC3339_PATTERN.test(row.timestamp_utc)) {
    findings.push({ file, line: lineNumber, message: `timestamp_utc not RFC3339: ${row.timestamp_utc}` });
  }
  if (method && !HTTP_METHODS.has(method)) {
    findings.push({ file, line: lineNumber, message: `Invalid HTTP method: ${method}` });
  }
  if (category && !OP_CATEGORIES.has(category)) {
    findings.push({ file, line: lineNumber, message: `Invalid op_category: ${category}` });
  }

  for (const required of ['timestamp_utc', 'method', 'op_category']) {
    if (!header.includes(required)) {
      findings.push({ file, line: 1, message: `Missing column ${required}` });
    }
  }

  if (!header.includes('sid_final') && !header.includes('generated_session_id')) {
    findings.push({ file, line: 1, message: 'Missing column sid_final (or generated_session_id) for ΔT compliance check' });
  }
  if (!header.includes('dt_sec') && !header.includes('delta_seconds') && !header.includes('delta_t')) {
    findings.push({ file, line: 1, message: 'Missing Δt column (dt_sec/delta_seconds/delta_t)' });
  }
};

const collectUid = (row: CsvRow): string | null => {
  const candidates = [row.uid, row.user_id, row.userId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
};

const collectSidFinal = (row: CsvRow): string | null => {
  const candidates = [row.sid_final, row.generated_session_id, row.session_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
};

const collectDeltaSeconds = (row: CsvRow): number | null => {
  const candidates = [row.dt_sec, row.delta_seconds, row.delta_t];
  for (const candidate of candidates) {
    const numeric = parseNumber(candidate);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
};

const enforceSidTransitions = (
  file: string,
  eventsMap: Map<string, ParsedEvent[]>,
  perUid: Map<string, UidInfo>,
  findings: AuditFinding[]
): number => {
  let checks = 0;
  for (const [uid, events] of eventsMap.entries()) {
    if (events.length < 2) {
      continue;
    }
    const sorted = events
      .slice()
      .sort((a, b) => {
        if (a.timestampMs === null && b.timestampMs === null) {
          return 0;
        }
        if (a.timestampMs === null) {
          return -1;
        }
        if (b.timestampMs === null) {
          return 1;
        }
        return a.timestampMs - b.timestampMs;
      });

    let previous = sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index];
      if (!current.sidFinal || !previous.sidFinal) {
        previous = current;
        continue;
      }
      if (current.sidFinal === previous.sidFinal) {
        previous = current;
        continue;
      }

      checks += 1;
      const uidInfo = perUid.get(uid);
      const threshold =
        current.threshold ??
        previous.threshold ??
        uidInfo?.threshold?.value ??
        null;

      if (threshold === null) {
        findings.push({
          file,
          line: current.line,
          message: `Missing ΔT for uid=${uid} while sid_final transitioned from ${previous.sidFinal} to ${current.sidFinal}`,
        });
        previous = current;
        continue;
      }

      let delta = current.deltaSeconds;
      if (delta === null && previous.timestampMs !== null && current.timestampMs !== null) {
        delta = (current.timestampMs - previous.timestampMs) / 1000;
      }

      if (delta === null) {
        findings.push({
          file,
          line: current.line,
          message: `Unable to determine Δt for uid=${uid} at sid_final transition`,
        });
        previous = current;
        continue;
      }

      if (delta <= threshold + EPSILON) {
        findings.push({
          file,
          line: current.line,
          message: `sid_final changed without exceeding ΔT for uid=${uid}: Δt=${delta.toFixed(6)}s, ΔT=${threshold.toFixed(6)}s`,
        });
      }

      previous = current;
    }
  }
  return checks;
};

const audit = async (options: AuditOptions): Promise<number> => {
  const files = await collectCsvFiles(options.paths);
  if (files.length === 0) {
    throw new Error(`No CSV files found under: ${options.paths.join(', ')}`);
  }

  const findings: AuditFinding[] = [];
  let totalRows = 0;
  let totalUnknown = 0;
  let totalTimeLabels = 0;
  const perUid = new Map<string, UidInfo>();
  const metaCache = new Map<string, MetaSummary | null>();
  let transitionChecks = 0;

  for (const file of files) {
    const directory = path.dirname(file);
    const content = await readFile(file, 'utf8');
    const { header, rows } = parseCsvContent(content);
    totalRows += rows.length;
    const eventsMap = new Map<string, ParsedEvent[]>();
    const uidsInFile = new Set<string>();

    const meta = await loadMetaForDirectory(directory, metaCache, findings, file);

    rows.forEach((row, index) => {
      const lineNumber = index + 2;
      validateRow(row, file, lineNumber, header, findings);

      const uid = collectUid(row);
      if (uid) {
        uidsInFile.add(uid);
      }

      const metadata = safeParseJson(row.metadata);
      const thresholdRecord = resolveThresholdFromRow(row, metadata, meta ?? null, uid);

      if (uid) {
        const info = perUid.get(uid) ?? {};
        if (thresholdRecord) {
          if (info.threshold && !approxEqual(info.threshold.value, thresholdRecord.value)) {
            findings.push({
              file,
              line: lineNumber,
              message: `Conflicting ΔT for uid=${uid}: existing=${info.threshold.value}, new=${thresholdRecord.value}`,
            });
          } else if (!info.threshold) {
            info.threshold = thresholdRecord;
          }
        }
        perUid.set(uid, info);
      }

      const timeLabel = row.time_label || row.timeLabel;
      if (typeof timeLabel === 'string' && timeLabel.trim().length > 0) {
        totalTimeLabels += 1;
        if (timeLabel.trim().toLowerCase() === 'unknown') {
          totalUnknown += 1;
        }
      }

      if (uid) {
        const sidFinal = collectSidFinal(row);
        const deltaSeconds = collectDeltaSeconds(row);
        const timestampValue = row.timestamp_utc || row.timestamp;
        const timestampMs = parseTimestampMs(timestampValue);
        const events = eventsMap.get(uid) ?? [];
        events.push({
          line: lineNumber,
          sidFinal,
          deltaSeconds,
          timestampMs,
          threshold: thresholdRecord ? thresholdRecord.value : null,
        });
        eventsMap.set(uid, events);
      }
    });

    if (meta) {
      for (const uid of uidsInFile) {
        const info = perUid.get(uid) ?? {};
        if (!info.threshold) {
          const metaThreshold = extractThresholdFromMeta(meta, uid);
          if (metaThreshold) {
            info.threshold = metaThreshold;
          }
        }
        const method = determineMethodFromMeta(meta, uid);
        if (method) {
          if (info.method && info.method !== method) {
            findings.push({
              file,
              line: 1,
              message: `Conflicting method for uid=${uid}: existing=${info.method}, new=${method}`,
            });
          } else {
            info.method = method;
          }
        }
        perUid.set(uid, info);
      }
    }

    transitionChecks += enforceSidTransitions(file, eventsMap, perUid, findings);
  }

  if (findings.length > 0) {
    findings.forEach((finding) => {
      console.error(`${finding.file}:${finding.line} ${finding.message}`);
    });
  }

  const perUidDeltaT: Record<string, number> = {};
  const methodUsage: Record<MethodChoice, number> = { otsu: 0, knee: 0, other: 0, unknown: 0 };
  perUid.forEach((info, uid) => {
    if (info.threshold) {
      perUidDeltaT[uid] = info.threshold.value;
    }
    if (info.method) {
      methodUsage[info.method] += 1;
    }
  });

  const summary: AuditSummary = {
    files: files.length,
    rows: totalRows,
    findings: findings.length,
    unknown_time_label_ratio:
      totalTimeLabels > 0 ? Number((totalUnknown / totalTimeLabels).toFixed(6)) : null,
    per_uid_delta_t: perUidDeltaT,
    method_usage: methodUsage,
    sid_final_transition_checks: transitionChecks,
  };

  console.log(JSON.stringify(summary));

  if (findings.length > 0 && options.failOnError) {
    return 1;
  }
  return findings.length > 0 ? 1 : 0;
};

const main = async (): Promise<void> => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const exitCode = await audit(options);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(`[audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

main();

export { audit, parseArgs };
export type { AuditOptions };
