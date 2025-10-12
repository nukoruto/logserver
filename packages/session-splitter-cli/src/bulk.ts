#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';

import { Command } from 'commander';
import { compile, TopLevelSpec } from 'vega-lite';
import * as vega from 'vega';
import { Resvg } from '@resvg/resvg-js';

import {
  AugmentedRow,
  KneeCurve,
  SessionSplitOptions,
  algoVersion,
  computeKneeCurve,
  deriveDatasetKey,
  estimateThresholdsWithMeta,
  makeLogHistogram,
  otsuThreshold,
  splitSessions,
  writeMeta,
  SessionSplitterError,
  ThresholdDetail,
  ThresholdMetaInput
} from '@logserver/session-splitter';

const HKDF_INFO_BASE64 = Buffer.from('sid', 'utf8').toString('base64');
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

interface BulkCliOptions {
  in: string;
  out: string;
  meta: string;
  epsilon?: number;
  k?: number;
  scanStep?: number;
  minEvents?: number;
  kid?: string;
  algo?: string;
  idleTimeout?: number;
  timestampColumn?: string;
  userColumn?: string;
  sessionColumn?: string;
  concurrency?: number;
  shardDir?: string;
  report?: string;
}

interface AugmentedColumnSpec {
  header: string;
  select: (row: AugmentedRow) => string | number | null | undefined;
}

class ProgressBar {
  private readonly total: number;
  private readonly width: number;
  private lastValue = 0;
  private lastRender = '';
  private lastTimestamp = 0;
  private lastLength = 0;

  constructor(total: number, width = 30) {
    this.total = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    this.width = width;
  }

  update(current: number): void {
    if (this.total <= 0) {
      this.renderMessage(`Processed ${current} rows`);
      this.lastValue = current;
      return;
    }
    const now = Date.now();
    if (current < this.total && current === this.lastValue && now - this.lastTimestamp < 200) {
      return;
    }
    this.lastValue = current;
    this.lastTimestamp = now;
    const clamped = Math.min(Math.max(current, 0), this.total);
    const ratio = clamped / this.total;
    const filled = Math.round(this.width * ratio);
    const empty = this.width - filled;
    const bar = `[${'#'.repeat(filled)}${'.'.repeat(empty)}]`;
    const percent = (ratio * 100).toFixed(1).padStart(6, ' ');
    const line = `${bar} ${percent}% (${clamped}/${this.total})`;
    this.renderMessage(line);
  }

  finish(finalValue?: number): void {
    if (this.total <= 0) {
      const value = finalValue ?? this.lastValue;
      this.renderMessage(`Processed ${value} rows`);
      process.stderr.write('\n');
      return;
    }
    this.update(this.total);
    process.stderr.write('\n');
  }

  private renderMessage(message: string): void {
    if (message === this.lastRender) {
      return;
    }
    this.lastRender = message;
    const padding = this.lastLength > message.length ? ' '.repeat(this.lastLength - message.length) : '';
    process.stderr.write(`\r${message}${padding}`);
    this.lastLength = message.length;
  }
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'string' ? value : String(value);
  if (/["\n,\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function ensureInputExists(filePath: string): Promise<void> {
  try {
    await fsPromises.access(filePath);
  } catch (error) {
    throw new SessionSplitterError(`Input file not found: ${filePath}`, error);
  }
}

async function countCsvRecords(filePath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = -1;
      while ((index = text.indexOf('\n', index + 1)) !== -1) {
        count += 1;
      }
    });
    stream.on('error', (error: unknown) => {
      reject(error);
    });
    stream.on('end', () => {
      const records = count > 0 ? Math.max(count - 1, 0) : 0;
      resolve(records);
    });
  });
}

function toSortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(Array.from(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function formatNumber(value: number | null | undefined, fractionDigits = 6): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }
  return value.toFixed(fractionDigits);
}

function computeLogStandardDeviation(values: Iterable<number>): number {
  const logs: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number') {
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
  let sum = 0;
  for (const value of logs) {
    sum += value;
  }
  const mean = sum / logs.length;
  let sumSq = 0;
  for (const value of logs) {
    const diff = value - mean;
    sumSq += diff * diff;
  }
  const variance = sumSq / logs.length;
  return variance > 0 && Number.isFinite(variance) ? Math.sqrt(variance) : 0;
}

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c >>>= 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i]!;
    const index = (crc ^ byte) & 0xff;
    crc = (CRC32_TABLE[index]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function addPngTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  if (!png || png.length < 8) {
    return png;
  }
  const signature = png.subarray(0, 8);
  const remainder = png.subarray(8);
  const keywordBuffer = Buffer.from(keyword, 'latin1');
  const textBuffer = Buffer.from(text, 'latin1');
  const nullSeparator = Buffer.from([0]);
  const data = Buffer.concat([keywordBuffer, nullSeparator, textBuffer]);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from('tEXt', 'ascii');
  const crcBuffer = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  const chunk = Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
  return Buffer.concat([signature, chunk, remainder]);
}

interface ThresholdAnnotation {
  key: string;
  label: string;
  threshold: number;
  logThreshold: number | null;
  formatted: string;
  color: string;
}

interface HistogramDataPoint {
  binStart: number;
  binEnd: number;
  count: number;
}

interface UserReportArtifacts {
  uid: string;
  sanitizedUid: string;
  histogramSpec: TopLevelSpec;
  sessionSpec: TopLevelSpec;
  summaryHtml: string;
  histogramPng: Buffer;
  sessionPng: Buffer;
}

const HISTOGRAM_WIDTH = 640;
const HISTOGRAM_HEIGHT = 360;
const CURVE_WIDTH = 640;
const CURVE_HEIGHT = 360;

const THRESHOLD_STYLES: Record<string, { label: string; color: string }> = {
  tau_final: { label: '最終閾値 (τ_final)', color: '#1f77b4' },
  tau_otsu: { label: 'Otsu 閾値 (τ_otsu)', color: '#d62728' },
  tau_knee: { label: '膝点 (τ_knee)', color: '#2ca02c' }
};

function buildThresholdAnnotations(detail: ThresholdDetail): ThresholdAnnotation[] {
  const annotations: ThresholdAnnotation[] = [];
  const finalValue = detail.DeltaT;
  annotations.push({
    key: 'tau_final',
    label: THRESHOLD_STYLES.tau_final.label,
    threshold: finalValue,
    logThreshold: detail.tau_final,
    formatted: `τ_final=${formatNumber(finalValue)}`,
    color: THRESHOLD_STYLES.tau_final.color
  });

  if (typeof detail.tau_otsu === 'number' && Number.isFinite(detail.tau_otsu)) {
    const value = Math.exp(detail.tau_otsu);
    annotations.push({
      key: 'tau_otsu',
      label: THRESHOLD_STYLES.tau_otsu.label,
      threshold: value,
      logThreshold: detail.tau_otsu,
      formatted: `τ_otsu=${formatNumber(value)}`,
      color: THRESHOLD_STYLES.tau_otsu.color
    });
  }

  if (typeof detail.tau_knee === 'number' && Number.isFinite(detail.tau_knee)) {
    const value = Math.exp(detail.tau_knee);
    annotations.push({
      key: 'tau_knee',
      label: THRESHOLD_STYLES.tau_knee.label,
      threshold: value,
      logThreshold: detail.tau_knee,
      formatted: `τ_knee=${formatNumber(value)}`,
      color: THRESHOLD_STYLES.tau_knee.color
    });
  }

  return annotations;
}

function buildHistogramData(histogram: ReturnType<typeof makeLogHistogram>): HistogramDataPoint[] {
  const points: HistogramDataPoint[] = [];
  const { binEdges, binCounts } = histogram;
  if (binEdges.length <= 1) {
    return points;
  }
  for (let i = 0; i < binCounts.length && i + 1 < binEdges.length; i += 1) {
    points.push({
      binStart: binEdges[i]!,
      binEnd: binEdges[i + 1]!,
      count: binCounts[i] ?? 0
    });
  }
  return points;
}

function createHistogramSpec(
  uid: string,
  histogramPoints: HistogramDataPoint[],
  annotations: ThresholdAnnotation[],
  sampleCount: number
): TopLevelSpec {
  if (histogramPoints.length === 0) {
    return {
      width: HISTOGRAM_WIDTH,
      height: HISTOGRAM_HEIGHT,
      background: 'white',
      data: { values: [{ message: 'Δt サンプルが不足しています' }] },
      mark: { type: 'text', align: 'center', baseline: 'middle', fontSize: 18 },
      encoding: {
        text: { field: 'message', type: 'nominal' }
      },
      title: `ユーザ ${uid}: Δt 対数ヒストグラム`
    } satisfies TopLevelSpec;
  }

  const annotationData = annotations.map((annotation) => ({
    label: annotation.label,
    threshold: annotation.threshold,
    formatted: annotation.formatted,
    color: annotation.color
  }));

  return {
    width: HISTOGRAM_WIDTH,
    height: HISTOGRAM_HEIGHT,
    background: 'white',
    title: `ユーザ ${uid}: Δt 対数ヒストグラム (サンプル数=${sampleCount})`,
    layer: [
      {
        data: { values: histogramPoints },
        mark: { type: 'bar', tooltip: true },
        encoding: {
          x: {
            field: 'binStart',
            type: 'quantitative',
            scale: { type: 'log' },
            axis: { title: 'Δt [秒] (対数軸)' }
          },
          x2: { field: 'binEnd' },
          y: {
            field: 'count',
            type: 'quantitative',
            axis: { title: '度数' }
          }
        }
      },
      {
        data: { values: annotationData },
        mark: { type: 'rule', strokeDash: [6, 4], size: 2 },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          color: {
            field: 'label',
            type: 'nominal',
            legend: { title: '閾値' }
          }
        }
      },
      {
        data: { values: annotationData },
        mark: { type: 'text', angle: -90, dy: -12, fontSize: 11 },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          text: { field: 'formatted', type: 'nominal' },
          color: { field: 'label', type: 'nominal', legend: null }
        }
      }
    ]
  } satisfies TopLevelSpec;
}

interface KneeSpecInput {
  uid: string;
  curve: KneeCurve;
  annotations: ThresholdAnnotation[];
  sampleCount: number;
  kneeDisplayThreshold: number;
  kneeLabel: string;
}

function findNearestPoint(points: KneeCurve['points'], target: number): { threshold: number; smoothed: number } {
  if (points.length === 0) {
    return { threshold: target, smoothed: 0 };
  }
  let bestIndex = 0;
  let bestDiff = Math.abs(points[0]!.threshold - target);
  for (let i = 1; i < points.length; i += 1) {
    const diff = Math.abs(points[i]!.threshold - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }
  return { threshold: points[bestIndex]!.threshold, smoothed: points[bestIndex]!.smoothed };
}

function createSessionCurveSpec(input: KneeSpecInput): TopLevelSpec {
  const { uid, curve, annotations, sampleCount, kneeDisplayThreshold, kneeLabel } = input;
  if (curve.points.length === 0) {
    return {
      width: CURVE_WIDTH,
      height: CURVE_HEIGHT,
      background: 'white',
      data: { values: [{ message: 'Δt サンプルが不足しています' }] },
      mark: { type: 'text', align: 'center', baseline: 'middle', fontSize: 18 },
      encoding: {
        text: { field: 'message', type: 'nominal' }
      },
      title: `ユーザ ${uid}: 膝点解析`
    } satisfies TopLevelSpec;
  }

  const kneePoint = findNearestPoint(curve.points, kneeDisplayThreshold);
  const annotationData = annotations.map((annotation) => ({
    label: annotation.label,
    threshold: annotation.threshold,
    formatted: annotation.formatted,
    color: annotation.color
  }));

  return {
    width: CURVE_WIDTH,
    height: CURVE_HEIGHT,
    background: 'white',
    title: `ユーザ ${uid}: セッション残数曲線 (サンプル数=${sampleCount})`,
    layer: [
      {
        data: { values: curve.points },
        mark: { type: 'line', strokeDash: [6, 4], color: '#9c9c9c' },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' }, axis: { title: 'Δt [秒] (対数軸)' } },
          y: { field: 'count', type: 'quantitative', axis: { title: 'セッション残数' } }
        }
      },
      {
        data: { values: curve.points },
        mark: { type: 'line', color: '#1f77b4' },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          y: { field: 'smoothed', type: 'quantitative' }
        }
      },
      {
        data: { values: [{
          threshold: kneePoint.threshold,
          smoothed: kneePoint.smoothed,
          label: '膝点',
          formatted: `膝点=${kneeLabel}`
        }] },
        mark: { type: 'point', filled: true, size: 90, color: THRESHOLD_STYLES.tau_knee.color },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          y: { field: 'smoothed', type: 'quantitative' },
          tooltip: { field: 'formatted', type: 'nominal' }
        }
      },
      {
        data: { values: [{
          threshold: kneePoint.threshold,
          smoothed: kneePoint.smoothed,
          text: `膝点=${kneeLabel}`
        }] },
        mark: { type: 'text', dy: -12, fontSize: 11, color: THRESHOLD_STYLES.tau_knee.color },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          y: { field: 'smoothed', type: 'quantitative' },
          text: { field: 'text', type: 'nominal' }
        }
      },
      {
        data: { values: annotationData },
        mark: { type: 'rule', strokeDash: [6, 4], size: 2 },
        encoding: {
          x: { field: 'threshold', type: 'quantitative', scale: { type: 'log' } },
          color: { field: 'label', type: 'nominal', legend: { title: '閾値' } }
        }
      }
    ]
  } satisfies TopLevelSpec;
}

function encodeHtml(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createUserReportHtml(
  uid: string,
  sanitizedUid: string,
  histogramSpec: TopLevelSpec,
  sessionSpec: TopLevelSpec,
  detail: ThresholdDetail,
  sampleCount: number,
  idleTimeout: number,
  epsilon: number
): string {
  const histogramSpecJson = JSON.stringify(histogramSpec);
  const sessionSpecJson = JSON.stringify(sessionSpec);
  const tableRows = [
    { label: 'サンプル数', value: String(sampleCount) },
    { label: 'idle_timeout_seconds', value: formatNumber(idleTimeout) },
    { label: 'epsilon', value: formatNumber(epsilon) },
    { label: 'Δt 最終閾値', value: formatNumber(detail.DeltaT) },
    { label: 'τ_final (log)', value: formatNumber(detail.tau_final) },
    { label: 'τ_otsu (log)', value: formatNumber(detail.tau_otsu) },
    { label: 'τ_knee (log)', value: formatNumber(detail.tau_knee) },
    { label: 'bimodality_test', value: formatNumber(detail.bimodality_test) },
    { label: 'backoff_level', value: encodeHtml(detail.backoff_level) }
  ];

  const tableHtml = tableRows
    .map((row) => `<tr><th>${row.label}</th><td>${row.value}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>ユーザ ${encodeHtml(uid)} しきい値レポート</title>
    <script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
    <script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
    <script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
    <style>
      body { font-family: 'Segoe UI', 'Hiragino Sans', sans-serif; margin: 24px; }
      h1 { margin-bottom: 0.2em; }
      .chart { margin-bottom: 32px; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #aaa; padding: 6px 12px; text-align: left; }
      th { background: #f3f3f3; }
      .meta { margin-bottom: 24px; }
    </style>
  </head>
  <body>
    <h1>ユーザ ${encodeHtml(uid)} レポート</h1>
    <div class="meta">
      <h2>しきい値まとめ</h2>
      <table>
        <tbody>
          ${tableHtml}
        </tbody>
      </table>
    </div>
    <div class="chart" id="histogram-${encodeHtml(sanitizedUid)}"></div>
    <div class="chart" id="curve-${encodeHtml(sanitizedUid)}"></div>
    <script type="text/javascript">
      const histogramSpec = ${histogramSpecJson};
      const sessionSpec = ${sessionSpecJson};
      vegaEmbed('#histogram-${encodeHtml(sanitizedUid)}', histogramSpec, { actions: false });
      vegaEmbed('#curve-${encodeHtml(sanitizedUid)}', sessionSpec, { actions: false });
    </script>
  </body>
</html>`;
}

interface RootSummaryRow {
  uid: string;
  sanitizedUid: string;
  detail: ThresholdDetail;
  sampleCount: number;
}

function createRootIndexHtml(rows: RootSummaryRow[]): string {
  const header = `<tr><th>UID</th><th>サンプル数</th><th>Δt 最終閾値</th><th>τ_final</th><th>τ_otsu</th><th>τ_knee</th><th>backoff_level</th><th>レポート</th></tr>`;
  const body = rows
    .map((row) => {
      const detail = row.detail;
      return `<tr>
        <td>${encodeHtml(row.uid)}</td>
        <td>${row.sampleCount}</td>
        <td>${formatNumber(detail.DeltaT)}</td>
        <td>${formatNumber(detail.tau_final)}</td>
        <td>${formatNumber(detail.tau_otsu)}</td>
        <td>${formatNumber(detail.tau_knee)}</td>
        <td>${encodeHtml(detail.backoff_level)}</td>
        <td><a href="${encodeHtml(row.sanitizedUid)}/index.html">リンク</a></td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>split-sessions 監査レポート</title>
    <style>
      body { font-family: 'Segoe UI', 'Hiragino Sans', sans-serif; margin: 24px; }
      h1 { margin-bottom: 0.5em; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #aaa; padding: 6px 12px; text-align: left; }
      th { background: #f3f3f3; }
    </style>
  </head>
  <body>
    <h1>split-sessions 監査レポート</h1>
    <table>
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>
  </body>
</html>`;
}

async function renderVegaLiteToPng(spec: TopLevelSpec): Promise<Buffer> {
  const compiled = compile(spec).spec;
  const runtime = vega.parse(compiled);
  const view = new vega.View(runtime, { renderer: 'none', logLevel: vega.Warn });
  const svg = await view.toSVG();
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' } });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}

async function generateReportArtifacts(
  uid: string,
  deltas: number[],
  detail: ThresholdDetail,
  kneeSigma: number,
  scanStep: number,
  minEvents: number,
  idleTimeout: number,
  epsilon: number
): Promise<UserReportArtifacts> {
  const sanitizedUid = sanitizeForFilename(uid);
  const sampleCount = deltas.length;
  const histogram = makeLogHistogram(deltas);
  const histogramPoints = buildHistogramData(histogram);

  const metaTauOtsu = typeof detail.tau_otsu === 'number' && Number.isFinite(detail.tau_otsu)
    ? detail.tau_otsu
    : null;
  const metaTauKnee = typeof detail.tau_knee === 'number' && Number.isFinite(detail.tau_knee)
    ? detail.tau_knee
    : null;

  const tolerance = 5e-3;
  let tauLogForCurve = metaTauOtsu;
  let computedTauLog: number | null = null;
  if (sampleCount >= minEvents && histogramPoints.length > 0) {
    const otsu = otsuThreshold(histogram);
    if (Number.isFinite(otsu.tauLog)) {
      computedTauLog = otsu.tauLog;
      if (tauLogForCurve === null) {
        tauLogForCurve = otsu.tauLog;
      }
    }
  }

  if (metaTauOtsu !== null && computedTauLog !== null) {
    const diff = Math.abs(metaTauOtsu - computedTauLog);
    if (diff > tolerance) {
      throw new SessionSplitterError(
        `Mismatch between meta τ_otsu=${metaTauOtsu} and computed τ_otsu=${computedTauLog} for uid=${uid}`
      );
    }
  }

  const sigmaLog = computeLogStandardDeviation(deltas);
  const curve = computeKneeCurve(deltas, tauLogForCurve ?? Number.NaN, sigmaLog, {
    kSigma: kneeSigma,
    logStep: scanStep
  });

  const kneeLogComputed = Number.isFinite(curve.knee.logThreshold) ? curve.knee.logThreshold : null;
  if (metaTauKnee !== null && kneeLogComputed !== null) {
    const diff = Math.abs(metaTauKnee - kneeLogComputed);
    if (diff > tolerance) {
      throw new SessionSplitterError(
        `Mismatch between meta τ_knee=${metaTauKnee} and computed τ_knee=${kneeLogComputed} for uid=${uid}`
      );
    }
  }

  const kneeDisplayThreshold = metaTauKnee !== null
    ? Math.exp(metaTauKnee)
    : kneeLogComputed !== null
    ? Math.exp(kneeLogComputed)
    : curve.points.length > 0
    ? curve.points[curve.points.length - 1]!.threshold
    : 0;
  const kneeLabel = formatNumber(
    metaTauKnee !== null
      ? Math.exp(metaTauKnee)
      : kneeLogComputed !== null
      ? Math.exp(kneeLogComputed)
      : null
  );

  const annotations = buildThresholdAnnotations(detail);
  const histogramSpec = createHistogramSpec(uid, histogramPoints, annotations, sampleCount);
  const sessionSpec = createSessionCurveSpec({
    uid,
    curve,
    annotations,
    sampleCount,
    kneeDisplayThreshold,
    kneeLabel
  });

  const histogramPng = await renderVegaLiteToPng(histogramSpec);
  const sessionPng = await renderVegaLiteToPng(sessionSpec);

  const histogramSummary = `uid=${uid};tau_final=${formatNumber(detail.DeltaT)};tau_otsu=${formatNumber(
    detail.tau_otsu !== null ? Math.exp(detail.tau_otsu) : null
  )};tau_knee=${formatNumber(detail.tau_knee !== null ? Math.exp(detail.tau_knee) : null)}`;
  const sessionSummary = `uid=${uid};knee=${kneeLabel};samples=${sampleCount}`;

  const histogramWithText = addPngTextChunk(histogramPng, 'AuditSummary', histogramSummary);
  const sessionWithText = addPngTextChunk(sessionPng, 'AuditSummary', sessionSummary);

  const summaryHtml = createUserReportHtml(
    uid,
    sanitizedUid,
    histogramSpec,
    sessionSpec,
    detail,
    sampleCount,
    idleTimeout,
    epsilon
  );

  return {
    uid,
    sanitizedUid,
    histogramSpec,
    sessionSpec,
    summaryHtml,
    histogramPng: histogramWithText,
    sessionPng: sessionWithText
  };
}

async function generateReports(
  reportDir: string,
  deltaMap: Map<string, number[]>,
  perUserDetails: Array<[string, ThresholdDetail]>,
  kneeSigma: number,
  scanStep: number,
  minEvents: number,
  idleTimeout: number,
  epsilon: number
): Promise<void> {
  if (perUserDetails.length === 0) {
    return;
  }
  await fsPromises.mkdir(reportDir, { recursive: true });

  const summaryRows: RootSummaryRow[] = [];
  for (const [uid, detail] of perUserDetails) {
    const deltas = deltaMap.get(uid) ?? [];
    const artifacts = await generateReportArtifacts(
      uid,
      deltas,
      detail,
      kneeSigma,
      scanStep,
      Math.floor(minEvents),
      idleTimeout,
      epsilon
    );
    const userDir = path.join(reportDir, artifacts.sanitizedUid);
    await fsPromises.mkdir(userDir, { recursive: true });
    await fsPromises.writeFile(path.join(userDir, 'histogram.png'), artifacts.histogramPng);
    await fsPromises.writeFile(path.join(userDir, 'session_curve.png'), artifacts.sessionPng);
    await fsPromises.writeFile(path.join(userDir, 'index.html'), artifacts.summaryHtml, 'utf8');
    summaryRows.push({
      uid: artifacts.uid,
      sanitizedUid: artifacts.sanitizedUid,
      detail,
      sampleCount: deltas.length
    });
  }

  const indexHtml = createRootIndexHtml(summaryRows.sort((a, b) => a.uid.localeCompare(b.uid)));
  await fsPromises.writeFile(path.join(reportDir, 'index.html'), indexHtml, 'utf8');
}

function createThresholdIterable(
  deltaMap: Map<string, number[]>,
  idleTimeout: number
): Iterable<AugmentedRow> {
  function* generator(): Generator<AugmentedRow> {
    for (const [uid, deltas] of deltaMap.entries()) {
      for (const delta of deltas) {
        yield {
          algo_ver: algoVersion,
          uid,
          generatedSessionId: '',
          sessionSequence: 0,
          sessionIndex: 0,
          timestampUtc: '',
          deltaSeconds: delta,
          idleTimeoutSeconds: idleTimeout,
          splitReason: 'continuous',
          original: {}
        };
      }
    }
  }
  return { [Symbol.iterator]: generator };
}

async function run(cliOptions: BulkCliOptions): Promise<void> {
  await ensureInputExists(cliOptions.in);

  const epsilon = cliOptions.epsilon;
  if (!Number.isFinite(epsilon) || epsilon! <= 0) {
    throw new SessionSplitterError('--epsilon must be a positive number');
  }
  const kneeSigma = cliOptions.k;
  if (!Number.isFinite(kneeSigma) || kneeSigma! < 0) {
    throw new SessionSplitterError('--k must be zero or a positive number');
  }
  const scanStep = cliOptions.scanStep;
  if (!Number.isFinite(scanStep) || scanStep! <= 0) {
    throw new SessionSplitterError('--scan-step must be a positive number');
  }
  const minEvents = cliOptions.minEvents ?? 50;
  if (!Number.isFinite(minEvents) || minEvents! <= 0) {
    throw new SessionSplitterError('--min-events must be a positive integer');
  }

  if (!cliOptions.algo) {
    throw new SessionSplitterError('--algo option is required');
  }
  if (cliOptions.algo !== algoVersion) {
    throw new SessionSplitterError(
      `Algorithm mismatch: requested "${cliOptions.algo}" but library exports "${algoVersion}"`
    );
  }

  const jwtKey = process.env.JWT_HMAC_KEY;
  if (!jwtKey) {
    throw new SessionSplitterError('JWT_HMAC_KEY environment variable is required');
  }

  const splitOptions: SessionSplitOptions = {
    idleTimeoutSeconds: cliOptions.idleTimeout,
    timestampColumn: cliOptions.timestampColumn,
    userIdColumn: cliOptions.userColumn,
    sessionIdColumn: cliOptions.sessionColumn,
    jwtHmacKey: jwtKey,
    datasetKey: deriveDatasetKey(jwtKey)
  };

  const totalRecords = await countCsvRecords(cliOptions.in).catch(() => 0);
  const progress = new ProgressBar(totalRecords);
  const startTime = process.hrtime.bigint();
  let peakRss = process.memoryUsage().rss;
  let processed = 0;
  let headerWritten = false;
  let idleTimeoutSeconds = splitOptions.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const originalHeaders: string[] = [];
  const augmentedColumns: AugmentedColumnSpec[] = [
    { header: 'algo_ver', select: (row) => row.algo_ver },
    { header: 'uid', select: (row) => row.uid },
    { header: 'generated_session_id', select: (row) => row.generatedSessionId },
    { header: 'session_sequence', select: (row) => row.sessionSequence },
    { header: 'session_index', select: (row) => row.sessionIndex },
    { header: 'timestamp_utc', select: (row) => row.timestampUtc },
    { header: 'delta_seconds', select: (row) => row.deltaSeconds },
    { header: 'idle_timeout_seconds', select: (row) => row.idleTimeoutSeconds },
    { header: 'split_reason', select: (row) => row.splitReason },
    { header: 'original_session_id', select: (row) => row.originalSessionId ?? '' }
  ];

  const deltaMap = new Map<string, number[]>();
  await fsPromises.mkdir(path.dirname(cliOptions.out), { recursive: true });
  const outputStream = createWriteStream(cliOptions.out, { encoding: 'utf8' });

  try {
    for await (const row of splitSessions(cliOptions.in, splitOptions)) {
      if (!headerWritten) {
        idleTimeoutSeconds = row.idleTimeoutSeconds;
        originalHeaders.splice(0, originalHeaders.length, ...Object.keys(row.original));
        const headerRow = [
          ...augmentedColumns.map((column) => column.header),
          ...originalHeaders
        ];
        outputStream.write(`${headerRow.map(csvEscape).join(',')}\n`);
        headerWritten = true;
      }

      const augmentedValues = augmentedColumns.map((column) => column.select(row));
      const originalValues = originalHeaders.map((key) => row.original[key]);
      const csvRow = [...augmentedValues, ...originalValues].map(csvEscape).join(',');
      outputStream.write(`${csvRow}\n`);

      if (typeof row.deltaSeconds === 'number' && Number.isFinite(row.deltaSeconds) && row.deltaSeconds > 0) {
        const list = deltaMap.get(row.uid);
        if (list) {
          list.push(row.deltaSeconds);
        } else {
          deltaMap.set(row.uid, [row.deltaSeconds]);
        }
      }

      processed += 1;
      progress.update(processed);
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) {
        peakRss = rss;
      }
    }
  } catch (error) {
    throw error instanceof SessionSplitterError ? error : new SessionSplitterError('Failed to split sessions', error);
  } finally {
    outputStream.end();
    await finished(outputStream);
    progress.finish(processed);
  }

  const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1_000_000_000;

  const thresholdsResult = await estimateThresholdsWithMeta(
    createThresholdIterable(deltaMap, idleTimeoutSeconds),
    {
      minimumSamples: Math.floor(minEvents),
      minEvents: Math.floor(minEvents),
      min_events: Math.floor(minEvents),
      knee: { kSigma: kneeSigma, logStep: scanStep },
      concurrency: cliOptions.concurrency,
      shard_dir: cliOptions.shardDir
    }
  );

  const thresholdsRecord = toSortedRecord(thresholdsResult.thresholds.entries());
  const perUserEntries = Array.from(thresholdsResult.perUser.entries());
  const fdBins = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.fd_bins] as [string, number]));
  const tauOtsu = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.tau_otsu] as [string, number | null])
  );
  const tauKnee = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.tau_knee] as [string, number | null])
  );
  const tauFinal = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.tau_final] as [string, number]));
  const deltaT = toSortedRecord(perUserEntries.map(([uid, detail]) => [uid, detail.DeltaT] as [string, number]));
  const bimodality = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.bimodality_test] as [string, number | null])
  );
  const backoffLevel = toSortedRecord(
    perUserEntries.map(([uid, detail]) => [uid, detail.backoff_level] as [string, string])
  );

  await fsPromises.mkdir(path.dirname(cliOptions.meta), { recursive: true });
  const kid = cliOptions.kid ?? createHash('sha256').update(splitOptions.datasetKey!).digest('hex').slice(0, 32);
  const metaPayload: ThresholdMetaInput = {
    algo_ver: algoVersion,
    epsilon: epsilon!,
    ntp_p95_ms: 0,
    ingress_jitter_ms: 0,
    fd_bins: fdBins,
    tau_otsu: tauOtsu,
    tau_knee: tauKnee,
    tau_final: tauFinal,
    DeltaT: deltaT,
    bimodality_test: bimodality,
    backoff_level: backoffLevel,
    k: thresholdsResult.k,
    scan_step: thresholdsResult.scan_step,
    hkdf_info: HKDF_INFO_BASE64,
    kid,
    datasetPath: cliOptions.in,
    thresholds_by_uid: thresholdsRecord
  };
  await writeMeta(cliOptions.meta, metaPayload);

  if (cliOptions.report) {
    const reportDir = path.resolve(cliOptions.report);
    await generateReports(
      reportDir,
      deltaMap,
      perUserEntries,
      kneeSigma!,
      scanStep!,
      Math.floor(minEvents),
      idleTimeoutSeconds,
      epsilon!
    );
  }

  const summary = {
    event: 'split_sessions_complete',
    rows_processed: processed,
    duration_seconds: Number.isFinite(durationSeconds) ? Number(durationSeconds.toFixed(6)) : durationSeconds,
    peak_rss_bytes: peakRss,
    output_path: path.resolve(cliOptions.out),
    meta_path: path.resolve(cliOptions.meta)
  };
  process.stderr.write(`[split-sessions] ${JSON.stringify(summary)}\n`);
}

const program = new Command();
program
  .name('split-sessions')
  .description('Batch session splitting CLI for Δt-aware session segmentation')
  .requiredOption('--in <path>', 'Path to input CSV file')
  .requiredOption('--out <path>', 'Path to write augmented CSV output')
  .option('--meta <path>', 'Path to write threshold metadata JSON', 'meta.json')
  .option('--epsilon <seconds>', 'Half of log resolution in seconds', (value) => Number(value))
  .option('--k <sigma>', 'K-sigma span for knee detection', (value) => Number(value))
  .option('--scan-step <step>', 'Log-domain scan step for knee detection', (value) => Number(value))
  .option('--min-events <count>', 'Minimum events per user for Otsu+knee', (value) => Number(value))
  .option('--kid <identifier>', 'Key identifier to record in metadata')
  .option('--algo <name>', 'Algorithm version label')
  .option('--idle-timeout <seconds>', 'Idle timeout seconds override', (value) => Number(value))
  .option('--timestamp-column <name>', 'Timestamp column override')
  .option('--user-column <name>', 'User identifier column override')
  .option('--session-column <name>', 'Original session identifier column override')
  .option('--concurrency <count>', 'Worker threads for threshold estimation', (value) => Number(value))
  .option('--shard-dir <path>', 'Directory for temporary threshold shards')
  .option('--report <path>', 'Directory to write audit report artifacts')
  .action(async (cliOptions: BulkCliOptions) => {
    try {
      await run(cliOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[split-sessions] error: ${message}`);
      if (error instanceof SessionSplitterError && (error as { cause?: unknown }).cause) {
        console.error(`[split-sessions] cause:`, (error as { cause?: unknown }).cause);
      }
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
