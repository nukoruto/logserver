import logger from '../utils/logger';
import { checkNtpOffset } from '../ntp/offset';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_THRESHOLD_MS = 50;
const DEFAULT_WARN_PERCENTILE = 95;
const DEFAULT_MAX_SAMPLES = 1_440; // store up to 24 hours of per-minute samples

const parseDisabled = (): boolean => {
  const raw = process.env.NTP_MONITOR_DISABLED;
  if (!raw) {
    return false;
  }
  const normalised = raw.trim().toLowerCase();
  return normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on';
};

export interface LoggerLike {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface NtpMonitorOptions {
  checkFn?: () => Promise<number>;
  intervalMs?: number;
  warnThresholdMs?: number;
  warnPercentile?: number;
  maxSamples?: number;
  disabled?: boolean;
  logger?: LoggerLike;
}

export interface NtpHealthStatus {
  disabled: boolean;
  healthy: boolean;
  state: 'disabled' | 'initializing' | 'ok' | 'degraded';
  httpStatus: number;
  percentileMs: number | null;
  percentileRank: number;
  thresholdMs: number;
  sampleCount: number;
  lastOffsetMs: number | null;
  lastError: string | null;
  lastCheck: Date | null;
}

type CheckFunction = () => Promise<number>;

export class NtpMonitor {
  private readonly checkFn: CheckFunction;

  private readonly intervalMs: number;

  private readonly warnThresholdMs: number;

  private readonly warnPercentile: number;

  private readonly maxSamples: number;

  private readonly logger: LoggerLike;

  private readonly disabled: boolean;

  private timer: NodeJS.Timeout | null = null;

  private started = false;

  private offsets: number[] = [];

  private lastPercentile: number | null = null;

  private unhealthy = false;

  private lastError: string | null = null;

  private lastCheck: Date | null = null;

  private lastOffset: number | null = null;

  constructor(options: NtpMonitorOptions = {}) {
    this.checkFn = options.checkFn ?? checkNtpOffset;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs ?? DEFAULT_WARN_THRESHOLD_MS;
    this.warnPercentile = options.warnPercentile ?? DEFAULT_WARN_PERCENTILE;
    this.maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
    this.logger = options.logger ?? logger;
    this.disabled = options.disabled ?? parseDisabled();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (this.disabled) {
      this.logger.info('NTP offset monitoring disabled');
      return;
    }

    this.logger.info('Starting NTP offset monitor', {
      interval_ms: this.intervalMs,
      warn_threshold_ms: this.warnThresholdMs,
      warn_percentile: this.warnPercentile,
    });

    void this.runCheck();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async checkNow(): Promise<number> {
    const offset = await this.checkFn();
    this.handleMeasurement(offset);
    return offset;
  }

  getStatus(): NtpHealthStatus {
    if (this.disabled) {
      return {
        disabled: true,
        healthy: true,
        state: 'disabled',
        httpStatus: 200,
        percentileMs: null,
        percentileRank: this.warnPercentile,
        thresholdMs: this.warnThresholdMs,
        sampleCount: 0,
        lastOffsetMs: null,
        lastError: null,
        lastCheck: null,
      };
    }

    if (this.offsets.length === 0) {
      return {
        disabled: false,
        healthy: false,
        state: 'initializing',
        httpStatus: 503,
        percentileMs: null,
        percentileRank: this.warnPercentile,
        thresholdMs: this.warnThresholdMs,
        sampleCount: 0,
        lastOffsetMs: this.lastOffset,
        lastError: this.lastError,
        lastCheck: this.lastCheck,
      };
    }

    if (this.unhealthy) {
      return {
        disabled: false,
        healthy: false,
        state: 'degraded',
        httpStatus: 503,
        percentileMs: this.lastPercentile,
        percentileRank: this.warnPercentile,
        thresholdMs: this.warnThresholdMs,
        sampleCount: this.offsets.length,
        lastOffsetMs: this.lastOffset,
        lastError: this.lastError,
        lastCheck: this.lastCheck,
      };
    }

    return {
      disabled: false,
      healthy: true,
      state: 'ok',
      httpStatus: 200,
      percentileMs: this.lastPercentile,
      percentileRank: this.warnPercentile,
      thresholdMs: this.warnThresholdMs,
      sampleCount: this.offsets.length,
      lastOffsetMs: this.lastOffset,
      lastError: this.lastError,
      lastCheck: this.lastCheck,
    };
  }

  private async runCheck(): Promise<void> {
    try {
      const offset = await this.checkFn();
      this.handleMeasurement(offset);
      this.logger.debug('Measured NTP offset', { offset_ms: offset });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.logger.warn('Failed to measure NTP offset', { error: message });
    } finally {
      this.lastCheck = new Date();
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (!this.started || this.disabled) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.runCheck();
    }, this.intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private handleMeasurement(offset: number): void {
    this.lastOffset = offset;
    this.lastError = null;
    this.recordSample(Math.abs(offset));
  }

  private recordSample(value: number): void {
    this.offsets.push(value);
    if (this.offsets.length > this.maxSamples) {
      this.offsets = this.offsets.slice(-this.maxSamples);
    }

    this.lastPercentile = this.computePercentile(this.offsets, this.warnPercentile);
    const unhealthy = this.lastPercentile !== null && this.lastPercentile > this.warnThresholdMs;

    if (unhealthy && !this.unhealthy) {
      this.logger.warn('NTP offset percentile exceeded threshold', {
        percentile_rank: this.warnPercentile,
        percentile_ms: this.lastPercentile,
        threshold_ms: this.warnThresholdMs,
      });
    } else if (!unhealthy && this.unhealthy) {
      this.logger.info('NTP offset percentile recovered within threshold', {
        percentile_rank: this.warnPercentile,
        percentile_ms: this.lastPercentile,
        threshold_ms: this.warnThresholdMs,
      });
    }

    this.unhealthy = unhealthy;
  }

  private computePercentile(values: number[], percentile: number): number | null {
    if (values.length === 0) {
      return null;
    }
    if (percentile <= 0) {
      return values[0];
    }
    if (percentile >= 100) {
      return values[values.length - 1];
    }

    const sorted = [...values].sort((a, b) => a - b);
    const rank = (percentile / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    const lowerValue = sorted[lowerIndex];
    const upperValue = sorted[upperIndex];

    if (lowerIndex === upperIndex) {
      return lowerValue;
    }

    const weight = rank - lowerIndex;
    return lowerValue + (upperValue - lowerValue) * weight;
  }
}

const ntpMonitor = new NtpMonitor();

export { ntpMonitor };
export default NtpMonitor;
