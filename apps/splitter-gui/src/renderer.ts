export {};

interface HistogramData {
  binEdges: number[];
  binCounts: number[];
  domain: { min: number; max: number; logMin: number; logMax: number };
  tauOtsu: number | null;
  tauKnee: number | null;
  tauFinal: number | null;
}

interface SessionCurveData {
  thresholds: number[];
  counts: number[];
  knee: number | null;
}

interface PreviewRow {
  algo_ver: string;
  uid: string;
  generatedSessionId: string;
  sessionSequence: number;
  sessionIndex: number;
  timestampUtc: string;
  deltaSeconds: number | null;
  idleTimeoutSeconds: number;
  splitReason: string;
  originalSessionId?: string;
  original: Record<string, string>;
}

interface PreviewResponse {
  filePath: string;
  algoVersion: string;
  users: string[];
  selectedUser: string | null;
  defaultDeltaT: number | null;
  appliedDeltaT: number | null;
  histogram: HistogramData;
  sessionCurve: SessionCurveData;
  thresholdsByUser: Record<string, number>;
  previewRows: PreviewRow[];
}

declare global {
  interface Window {
    sessionSplitter: {
      algoVersion: string;
      selectFile: () => Promise<string | null>;
      preview: (payload: {
        filePath: string;
        options?: { idleTimeoutSeconds?: number };
        selectedUser?: string | null;
        overrideDeltaT?: number | null;
      }) => Promise<PreviewResponse>;
      export: (
        payload: {
          filePath: string;
          options?: { idleTimeoutSeconds?: number };
          selectedUser?: string | null;
          overrideDeltaT?: number | null;
        }
      ) => Promise<{ canceled: boolean; output?: { rowsPath: string; thresholdsPath: string; metaPath: string } }>;
    };
  }
}

const selectFileButton = document.getElementById('select-file');
const exportButton = document.getElementById('export');
const idleInput = document.getElementById('idle-timeout') as HTMLInputElement | null;
const filePathElement = document.getElementById('file-path');
const statusElement = document.getElementById('status');
const algoElement = document.getElementById('algo-version');
const userSelect = document.getElementById('user-select') as HTMLSelectElement | null;
const deltaSlider = document.getElementById('delta-slider') as HTMLInputElement | null;
const deltaInput = document.getElementById('delta-input') as HTMLInputElement | null;
const histogramCanvas = document.getElementById('histogram') as HTMLCanvasElement | null;
const sessionCanvas = document.getElementById('session-curve') as HTMLCanvasElement | null;
const previewTableBody = document.querySelector<HTMLTableSectionElement>('#preview-table tbody');
const thresholdList = document.getElementById('threshold-list');

const DEFAULT_SLIDER_STEP = 0.001;

let currentFilePath: string | null = null;
let latestPreview: PreviewResponse | null = null;
let suppressDeltaUpdate = false;

if (algoElement) {
  algoElement.textContent = window.sessionSplitter.algoVersion;
}

if (selectFileButton) {
  selectFileButton.addEventListener('click', async () => {
    await handleSelectFile();
  });
}

if (userSelect) {
  userSelect.addEventListener('change', () => {
    void refreshPreview();
  });
}

if (deltaSlider) {
  deltaSlider.addEventListener('input', () => {
    if (suppressDeltaUpdate) {
      return;
    }
    if (deltaInput) {
      deltaInput.value = deltaSlider.value;
    }
    void refreshPreview();
  });
}

if (deltaInput) {
  deltaInput.addEventListener('input', () => {
    if (suppressDeltaUpdate) {
      return;
    }
    const numeric = Number(deltaInput.value);
    if (deltaSlider && Number.isFinite(numeric)) {
      deltaSlider.value = String(numeric);
    }
    void refreshPreview();
  });
}

if (exportButton) {
  exportButton.addEventListener('click', async () => {
    if (!currentFilePath) {
      updateStatus('CSV ファイルを選択してください。', true);
      return;
    }
    try {
      updateStatus('エクスポート中...', false);
      const payload = buildPreviewPayload();
      const result = await window.sessionSplitter.export(payload);
      if (result.canceled) {
        updateStatus('エクスポートはキャンセルされました。', true);
      } else if (result.output) {
        updateStatus(
          `エクスポート完了: rows=${result.output.rowsPath}, thresholds=${result.output.thresholdsPath}, meta=${result.output.metaPath}`,
          false
        );
      } else {
        updateStatus('エクスポートが完了しました。', false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStatus(`エクスポート失敗: ${message}`, true);
    }
  });
}

function buildPreviewPayload(): {
  filePath: string;
  options?: { idleTimeoutSeconds?: number };
  selectedUser?: string | null;
  overrideDeltaT?: number | null;
} {
  const idleTimeout = idleInput?.value ? Number(idleInput.value) : undefined;
  const selectedUser = userSelect?.value ? userSelect.value : undefined;
  const override = deltaInput?.value ? Number(deltaInput.value) : undefined;
  return {
    filePath: currentFilePath as string,
    options: {
      idleTimeoutSeconds: idleTimeout && Number.isFinite(idleTimeout) ? idleTimeout : undefined
    },
    selectedUser,
    overrideDeltaT: override && Number.isFinite(override) && override > 0 ? override : undefined
  };
}

async function handleSelectFile(): Promise<void> {
  try {
    updateStatus('CSV ファイルを選択しています...', false);
    const filePath = await window.sessionSplitter.selectFile();
    if (!filePath) {
      updateStatus('ファイル選択がキャンセルされました。', true);
      return;
    }
    currentFilePath = filePath;
    if (filePathElement) {
      filePathElement.textContent = filePath;
    }
    await refreshPreview(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus(`ファイル選択エラー: ${message}`, true);
  }
}

async function refreshPreview(force = false): Promise<void> {
  if (!currentFilePath) {
    return;
  }
  const payload = buildPreviewPayload();
  if (!force && latestPreview && payload.filePath === latestPreview.filePath) {
    updateStatus('プレビューを更新中...', false);
  } else {
    updateStatus('解析中...', false);
  }
  try {
    const preview = await window.sessionSplitter.preview(payload);
    latestPreview = preview;
    updateUserSelect(preview.users, preview.selectedUser);
    updateDeltaControls(preview);
    renderHistogram(preview.histogram, preview.appliedDeltaT);
    renderSessionCurve(preview.sessionCurve, preview.appliedDeltaT);
    renderThresholdList(preview.thresholdsByUser, preview.selectedUser, preview.defaultDeltaT, preview.appliedDeltaT);
    renderPreviewTable(preview.previewRows);
    updateStatus('プレビュー更新完了。', false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus(`プレビューエラー: ${message}`, true);
  }
}

function updateUserSelect(users: string[], selected: string | null): void {
  if (!userSelect) {
    return;
  }
  const previous = new Set<string>();
  for (const option of Array.from(userSelect.options)) {
    previous.add(option.value);
  }
  if (users.length !== previous.size || users.some((user) => !previous.has(user))) {
    userSelect.innerHTML = '';
    for (const user of users) {
      const option = document.createElement('option');
      option.value = user;
      option.textContent = user;
      userSelect.appendChild(option);
    }
  }
  if (selected) {
    userSelect.value = selected;
  }
}

function updateDeltaControls(preview: PreviewResponse): void {
  const { histogram, defaultDeltaT, appliedDeltaT } = preview;
  const min = histogram.domain.min > 0 ? histogram.domain.min : defaultDeltaT ?? 0.001;
  const max = histogram.domain.max > 0 ? histogram.domain.max : (defaultDeltaT ?? 1) * 10;
  const step = computeSliderStep(min, max);
  suppressDeltaUpdate = true;
  if (deltaSlider) {
    deltaSlider.min = String(min);
    deltaSlider.max = String(max);
    deltaSlider.step = String(step);
    if (appliedDeltaT && Number.isFinite(appliedDeltaT)) {
      deltaSlider.value = String(appliedDeltaT);
    }
  }
  if (deltaInput) {
    deltaInput.min = String(min);
    deltaInput.max = String(max);
    deltaInput.step = String(step);
    if (appliedDeltaT && Number.isFinite(appliedDeltaT)) {
      deltaInput.value = formatNumber(appliedDeltaT);
    } else {
      deltaInput.value = '';
    }
  }
  suppressDeltaUpdate = false;
}

function computeSliderStep(min: number, max: number): number {
  const span = max - min;
  if (!(span > 0)) {
    return DEFAULT_SLIDER_STEP;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(span)) - 2);
  const step = Math.max(DEFAULT_SLIDER_STEP, magnitude);
  return Number.isFinite(step) && step > 0 ? step : DEFAULT_SLIDER_STEP;
}

function renderHistogram(data: HistogramData, overrideDelta: number | null): void {
  if (!histogramCanvas) {
    return;
  }
  const ctx = histogramCanvas.getContext('2d');
  if (!ctx) {
    return;
  }
  const { width, height } = histogramCanvas;
  ctx.clearRect(0, 0, width, height);
  if (data.binEdges.length === 0 || data.binCounts.length === 0) {
    drawEmptyState(ctx, width, height, 'ΔT データが不足しています');
    return;
  }
  const padding = 24;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const maxCount = Math.max(...data.binCounts);
  const logMin = data.domain.logMin;
  const logMax = data.domain.logMax;
  ctx.fillStyle = '#1d4ed8';
  for (let i = 0; i < data.binCounts.length; i += 1) {
    const start = Math.log(data.binEdges[i]);
    const end = Math.log(data.binEdges[i + 1]);
    const xStart = padding + ((start - logMin) / (logMax - logMin)) * chartWidth;
    const xEnd = padding + ((end - logMin) / (logMax - logMin)) * chartWidth;
    const barWidth = Math.max(1, xEnd - xStart);
    const barHeight = (data.binCounts[i] / maxCount) * chartHeight;
    ctx.fillRect(xStart, padding + chartHeight - barHeight, barWidth, barHeight);
  }

  drawVerticalMarker(ctx, data.tauOtsu, logMin, logMax, chartHeight, padding, '#f97316', 'Otsu');
  drawVerticalMarker(ctx, data.tauFinal, logMin, logMax, chartHeight, padding, '#10b981', '推奨');
  drawVerticalMarker(ctx, overrideDelta, logMin, logMax, chartHeight, padding, '#ef4444', '手動');
}

function drawVerticalMarker(
  ctx: CanvasRenderingContext2D,
  value: number | null,
  logMin: number,
  logMax: number,
  chartHeight: number,
  padding: number,
  color: string,
  label: string
): void {
  if (!(typeof value === 'number') || !(value > 0)) {
    return;
  }
  const { width } = ctx.canvas;
  const x = padding + ((Math.log(value) - logMin) / (logMax - logMin)) * (width - padding * 2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, padding);
  ctx.lineTo(x, padding + chartHeight);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, padding - 6);
  ctx.restore();
}

function renderSessionCurve(data: SessionCurveData, overrideDelta: number | null): void {
  if (!sessionCanvas) {
    return;
  }
  const ctx = sessionCanvas.getContext('2d');
  if (!ctx) {
    return;
  }
  const { width, height } = sessionCanvas;
  ctx.clearRect(0, 0, width, height);
  if (data.thresholds.length === 0 || data.counts.length === 0) {
    drawEmptyState(ctx, width, height, 'セッション候補がありません');
    return;
  }
  const padding = 32;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const logMin = Math.log(Math.min(...data.thresholds));
  const logMax = Math.log(Math.max(...data.thresholds));
  const maxCount = Math.max(...data.counts);
  ctx.save();
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.thresholds.forEach((threshold, index) => {
    const x = padding + ((Math.log(threshold) - logMin) / (logMax - logMin)) * chartWidth;
    const y = padding + chartHeight - (data.counts[index] / maxCount) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  drawKneePoint(ctx, data, logMin, logMax, chartWidth, chartHeight, padding, '#fbbf24');
  drawVerticalMarker(ctx, overrideDelta, logMin, logMax, chartHeight, padding, '#ef4444', '手動');
  ctx.restore();
}

function drawKneePoint(
  ctx: CanvasRenderingContext2D,
  data: SessionCurveData,
  logMin: number,
  logMax: number,
  chartWidth: number,
  chartHeight: number,
  padding: number,
  color: string
): void {
  if (!(typeof data.knee === 'number') || !(data.knee > 0)) {
    return;
  }
  const maxCount = Math.max(...data.counts);
  const kneeIndex = findClosestIndex(data.thresholds, data.knee);
  const threshold = data.thresholds[kneeIndex];
  const count = data.counts[kneeIndex];
  const x = padding + ((Math.log(threshold) - logMin) / (logMax - logMin)) * chartWidth;
  const y = padding + chartHeight - (count / maxCount) * chartHeight;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('膝点', x, y - 12);
  ctx.restore();
}

function findClosestIndex(values: number[], target: number): number {
  let best = 0;
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const diff = Math.abs(values[i] - target);
    if (diff < minDiff) {
      minDiff = diff;
      best = i;
    }
  }
  return best;
}

function drawEmptyState(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  message: string
): void {
  ctx.save();
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#475569';
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  ctx.restore();
}

function renderThresholdList(
  thresholds: Record<string, number>,
  selectedUser: string | null,
  defaultDelta: number | null,
  appliedDelta: number | null
): void {
  if (!thresholdList) {
    return;
  }
  thresholdList.innerHTML = '';
  const entries = Object.entries(thresholds).sort(([a], [b]) => a.localeCompare(b));
  for (const [uid, value] of entries) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${uid}: ΔT=${formatNumber(value)}s`;
    if (uid === selectedUser) {
      label.classList.add('selected-user');
    }
    item.appendChild(label);
    thresholdList.appendChild(item);
  }
  const manual = document.getElementById('manual-threshold');
  if (manual) {
    manual.textContent = appliedDelta ? formatNumber(appliedDelta) : '-';
  }
  const auto = document.getElementById('auto-threshold');
  if (auto) {
    auto.textContent = defaultDelta ? formatNumber(defaultDelta) : '-';
  }
}

function renderPreviewTable(rows: PreviewRow[]): void {
  if (!previewTableBody) {
    return;
  }
  previewTableBody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    addCell(tr, row.uid);
    addCell(tr, formatNumber(row.deltaSeconds));
    addCell(tr, row.splitReason);
    addCell(tr, row.timestampUtc);
    previewTableBody.appendChild(tr);
  }
}

function addCell(row: HTMLTableRowElement, value: string | number | null | undefined): void {
  const td = document.createElement('td');
  td.textContent = formatValue(value);
  row.appendChild(td);
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  if (value == null) {
    return '-';
  }
  return String(value);
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  if (value >= 1) {
    return value.toFixed(2);
  }
  if (value >= 0.001) {
    return value.toFixed(3);
  }
  return value.toExponential(2);
}

function updateStatus(message: string, isError: boolean): void {
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message;
  statusElement.className = isError ? 'error' : 'info';
}

