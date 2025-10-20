import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  algoVersion,
  splitSessions,
  estimateThresholdsWithMeta,
  makeLogHistogram,
  SessionSplitOptions,
  AugmentedRow,
  ThresholdComputationResult,
  ThresholdDetail,
  deriveDatasetKey,
  writeMeta
} from '@logserver/session-splitter';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PreviewRequest {
  filePath: string;
  options?: Partial<SessionSplitOptions>;
  selectedUser?: string | null;
  overrideDeltaT?: number | null;
}

interface ExportRequest extends PreviewRequest {
  outputDir?: string | null;
}

interface PreviewResponse {
  filePath: string;
  algoVersion: string;
  users: string[];
  selectedUser: string | null;
  defaultDeltaT: number | null;
  appliedDeltaT: number | null;
  histogram: {
    binEdges: number[];
    binCounts: number[];
    domain: { min: number; max: number; logMin: number; logMax: number };
    tauOtsu: number | null;
    tauKnee: number | null;
    tauFinal: number | null;
  };
  sessionCurve: {
    thresholds: number[];
    counts: number[];
    knee: number | null;
  };
  thresholdsByUser: Record<string, number>;
  perUserDetail: Record<string, ThresholdDetail>;
  previewRows: AugmentedRow[];
}

interface LoadedDataset {
  key: string;
  filePath: string;
  options: SessionSplitOptions;
  datasetKey: Buffer;
  rows: AugmentedRow[];
  thresholds: ThresholdComputationResult;
  deltasByUser: Map<string, number[]>;
}

const HKDF_INFO_BASE64 = Buffer.from('sid', 'utf8').toString('base64');

let cachedDataset: LoadedDataset | null = null;

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  await mainWindow.loadFile(path.join(__dirname, '../static/index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function registerIpcHandlers(): void {
  ipcMain.handle('split/select-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('split/preview', async (_event, payload: PreviewRequest) => {
    const dataset = await ensureDatasetLoaded(payload);
    return buildPreviewResponse(dataset, payload);
  });

  ipcMain.handle('split/export', async (_event, payload: ExportRequest) => {
    const dataset = await ensureDatasetLoaded(payload);
    const exportResult = await exportDataset(dataset, payload);
    return exportResult;
  });
}

function ensureJwtKey(): string {
  const key = process.env.JWT_HMAC_KEY;
  if (!key) {
    throw new Error('JWT_HMAC_KEY environment variable must be set');
  }
  return key;
}

function buildOptionsKey(filePath: string, options: SessionSplitOptions): string {
  const normalized = {
    filePath,
    idleTimeoutSeconds: options.idleTimeoutSeconds ?? null,
    timestampColumn: options.timestampColumn ?? null,
    userIdColumn: options.userIdColumn ?? null,
    sessionIdColumn: options.sessionIdColumn ?? null
  };
  return JSON.stringify(normalized);
}

async function ensureDatasetLoaded(request: PreviewRequest): Promise<LoadedDataset> {
  if (!request.filePath) {
    throw new Error('CSV ファイルを指定してください');
  }
  const jwtKey = ensureJwtKey();
  const datasetKey = deriveDatasetKey(jwtKey);
  const options: SessionSplitOptions = {
    ...request.options,
    jwtHmacKey: jwtKey,
    datasetKey
  };
  const cacheKey = buildOptionsKey(request.filePath, options);
  if (cachedDataset && cachedDataset.key === cacheKey) {
    return cachedDataset;
  }

  const rows: AugmentedRow[] = [];
  for await (const row of splitSessions(request.filePath, options)) {
    rows.push(row);
  }
  const thresholds = await estimateThresholdsWithMeta(rows);
  const deltasByUser = new Map<string, number[]>();
  for (const row of rows) {
    const delta = row.deltaSeconds;
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta <= 0) {
      continue;
    }
    const list = deltasByUser.get(row.uid);
    if (list) {
      list.push(delta);
    } else {
      deltasByUser.set(row.uid, [delta]);
    }
  }
  for (const list of deltasByUser.values()) {
    list.sort((a, b) => a - b);
  }

  cachedDataset = {
    key: cacheKey,
    filePath: request.filePath,
    options,
    datasetKey,
    rows,
    thresholds,
    deltasByUser
  };
  return cachedDataset;
}

function buildPreviewResponse(dataset: LoadedDataset, request: PreviewRequest): PreviewResponse {
  const users = Array.from(dataset.deltasByUser.keys()).sort((a, b) => a.localeCompare(b));
  const selected = request.selectedUser && users.includes(request.selectedUser)
    ? request.selectedUser
    : users[0] ?? null;

  const detailMap = dataset.thresholds.perUser;
  const detailRecord: Record<string, ThresholdDetail> = Object.fromEntries(
    Array.from(detailMap.entries()).map(([uid, detail]) => [uid, detail])
  );
  const thresholdsRecord = Object.fromEntries(
    Array.from(dataset.thresholds.thresholds.entries()).map(([uid, value]) => [uid, value])
  );

  const targetDetail = selected ? detailMap.get(selected) ?? null : null;
  const defaultDelta = targetDetail ? targetDetail.DeltaT : null;
  const overrideCandidate = request.overrideDeltaT;
  const appliedDelta = typeof overrideCandidate === 'number' && Number.isFinite(overrideCandidate) && overrideCandidate > 0
    ? overrideCandidate
    : defaultDelta;

  const deltas = selected ? dataset.deltasByUser.get(selected) ?? [] : [];
  const histogram = makeLogHistogram(deltas);
  const sessionCurve = buildSessionCurve(deltas);
  const tauOtsu = targetDetail?.tau_otsu != null ? Math.exp(targetDetail.tau_otsu) : null;
  const tauKnee = targetDetail?.tau_knee != null ? Math.exp(targetDetail.tau_knee) : null;
  const tauFinal = targetDetail?.tau_final != null ? Math.exp(targetDetail.tau_final) : null;

  const previewRows = selected
    ? dataset.rows.filter((row) => row.uid === selected).slice(0, 25)
    : dataset.rows.slice(0, 25);

  return {
    filePath: dataset.filePath,
    algoVersion,
    users,
    selectedUser: selected,
    defaultDeltaT: defaultDelta ?? null,
    appliedDeltaT: appliedDelta ?? null,
    histogram: {
      binEdges: histogram.binEdges,
      binCounts: histogram.binCounts,
      domain: histogram.domain,
      tauOtsu,
      tauKnee,
      tauFinal
    },
    sessionCurve: {
      thresholds: sessionCurve.thresholds,
      counts: sessionCurve.counts,
      knee: tauKnee
    },
    thresholdsByUser: thresholdsRecord,
    perUserDetail: detailRecord,
    previewRows
  };
}

function buildSessionCurve(values: number[]): { thresholds: number[]; counts: number[] } {
  if (values.length === 0) {
    return { thresholds: [], counts: [] };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const positive = sorted.filter((value) => value > 0 && Number.isFinite(value));
  if (positive.length === 0) {
    return { thresholds: [], counts: [] };
  }
  const min = positive[0];
  const max = positive[positive.length - 1];
  if (!(max > 0) || !(min > 0)) {
    return { thresholds: [], counts: [] };
  }
  const minLog = Math.log(min);
  const maxLog = Math.log(max);
  if (maxLog <= minLog) {
    return { thresholds: [max], counts: [1] };
  }
  const pointCount = Math.min(positive.length, 64);
  const thresholds: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < pointCount; i += 1) {
    const ratio = pointCount === 1 ? 1 : i / (pointCount - 1);
    const logValue = minLog + (maxLog - minLog) * ratio;
    const threshold = Math.exp(logValue);
    thresholds.push(threshold);
    const count = positive.length - upperBound(positive, threshold);
    counts.push(count + 1);
  }
  return { thresholds, counts };
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

async function exportDataset(dataset: LoadedDataset, request: ExportRequest): Promise<{
  canceled: boolean;
  output?: { rowsPath: string; thresholdsPath: string; metaPath: string };
}> {
  let targetDir = request.outputDir ?? null;
  if (!targetDir) {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    targetDir = result.filePaths[0];
  }
  if (!targetDir) {
    return { canceled: true };
  }

  await fs.mkdir(targetDir, { recursive: true });

  const baseName = path.basename(dataset.filePath, path.extname(dataset.filePath));
  const rowsPath = path.join(targetDir, `${baseName}.ndjson`);
  const thresholdsPath = path.join(targetDir, `${baseName}.thresholds.json`);
  const metaPath = path.join(targetDir, 'meta.json');

  const rowsPayload = dataset.rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(rowsPath, rowsPayload, 'utf8');

  const overrideUser = request.selectedUser ?? null;
  const overrideDelta =
    typeof request.overrideDeltaT === 'number' && Number.isFinite(request.overrideDeltaT) && request.overrideDeltaT > 0
      ? request.overrideDeltaT
      : null;

  const thresholdsEntries = Array.from(dataset.thresholds.thresholds.entries());
  const thresholdsRecord = Object.fromEntries(
    thresholdsEntries.map(([uid, value]) => [uid, uid === overrideUser && overrideDelta ? overrideDelta : value])
  );

  await fs.writeFile(
    thresholdsPath,
    `${JSON.stringify({ algo_ver: algoVersion, thresholds: sortRecord(thresholdsRecord) })}\n`,
    'utf8'
  );

  const perUser = new Map(dataset.thresholds.perUser.entries());
  if (overrideUser && overrideDelta) {
    const detail = perUser.get(overrideUser);
    if (detail) {
      const safe = Math.max(overrideDelta, Number.MIN_VALUE);
      perUser.set(overrideUser, {
        ...detail,
        DeltaT: overrideDelta,
        tau_final: Math.log(safe)
      });
    }
  }

  const perUserEntries = Array.from(perUser.entries());
  const fdBins = sortRecord(Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.fd_bins])));
  const tauOtsu = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.tau_otsu ?? null]))
  );
  const tauKnee = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.tau_knee ?? null]))
  );
  const tauFinal = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.tau_final]))
  );
  const deltaT = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.DeltaT]))
  );
  const bimodality = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.bimodality_test ?? null]))
  );
  const backoffLevel = sortRecord(
    Object.fromEntries(perUserEntries.map(([uid, detail]) => [uid, detail.backoff_level]))
  );

  const kid = createHash('sha256').update(dataset.datasetKey).digest('hex').slice(0, 32);

  await writeMeta(metaPath, {
    algo_ver: algoVersion,
    epsilon: 0,
    ntp_p95_ms: 0,
    ingress_jitter_ms: 0,
    fd_bins: fdBins,
    tau_otsu: tauOtsu,
    tau_knee: tauKnee,
    tau_final: tauFinal,
    DeltaT: deltaT,
    bimodality_test: bimodality,
    backoff_level: backoffLevel,
    k: dataset.thresholds.k,
    scan_step: dataset.thresholds.scan_step,
    hkdf_info: HKDF_INFO_BASE64,
    kid,
    datasetPath: dataset.filePath,
    thresholds_by_uid: sortRecord(thresholdsRecord)
  });

  return {
    canceled: false,
    output: { rowsPath, thresholdsPath, metaPath }
  };
}

function sortRecord<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
