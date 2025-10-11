const logger = require('../utils/logger');
const { checkNtpOffset } = require('../ntp/offset');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_THRESHOLD_MS = 50;
const DEFAULT_WARN_PERCENTILE = 95;
const DEFAULT_MAX_SAMPLES = 1_440;

const parseDisabled = () => {
  const raw = process.env.NTP_MONITOR_DISABLED;
  if (!raw) {
    return false;
  }
  const normalised = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalised);
};

class NtpMonitor {
  constructor(options = {}) {
    this.checkFn = options.checkFn || checkNtpOffset;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.warnThresholdMs = options.warnThresholdMs || DEFAULT_WARN_THRESHOLD_MS;
    this.warnPercentile = options.warnPercentile || DEFAULT_WARN_PERCENTILE;
    this.maxSamples = options.maxSamples || DEFAULT_MAX_SAMPLES;
    this.logger = options.logger || logger;
    this.disabled = options.disabled !== undefined ? options.disabled : parseDisabled();
    this.timer = null;
    this.started = false;
    this.offsets = [];
    this.lastPercentile = null;
    this.unhealthy = false;
    this.lastError = null;
    this.lastCheck = null;
    this.lastOffset = null;
  }

  start() {
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

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async checkNow() {
    const offset = await this.checkFn();
    this.handleMeasurement(offset);
    return offset;
  }

  getStatus() {
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

  async runCheck() {
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

  scheduleNext() {
    if (!this.started || this.disabled) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.runCheck();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  handleMeasurement(offset) {
    this.lastOffset = offset;
    this.lastError = null;
    this.recordSample(Math.abs(offset));
  }

  recordSample(value) {
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

  computePercentile(values, percentile) {
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

module.exports = {
  NtpMonitor,
  ntpMonitor,
  default: NtpMonitor,
};
