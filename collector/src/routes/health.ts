import express from 'express';
import logCapture from '../middleware/logCapture';
import { csvSink } from '../index';
import { ntpMonitor, type NtpHealthStatus } from '../services/ntpMonitor';
import type { CsvSinkHealthStatus } from '../sink/csvSink';

export type OverallHealthState = 'ok' | 'degraded' | 'initializing' | 'shutting_down';

export interface CombinedHealthStatus {
  healthy: boolean;
  status: OverallHealthState;
  reasons: string[];
  components: {
    csvSink: CsvSinkHealthStatus;
    ntp: NtpHealthStatus;
  };
}

const router = express.Router();

export const deriveOverallHealth = (
  csvStatus: CsvSinkHealthStatus,
  ntpStatus: NtpHealthStatus
): CombinedHealthStatus => {
  const sinkHealthy = csvStatus.healthy;
  const ntpHealthy = ntpStatus.disabled ? true : ntpStatus.healthy;

  const reasons: string[] = [];

  if (!sinkHealthy) {
    reasons.push(csvStatus.state === 'shutting_down' ? 'csv_sink_shutting_down' : 'csv_sink_unavailable');
  }

  if (!ntpHealthy) {
    reasons.push(ntpStatus.state === 'initializing' ? 'ntp_initializing' : 'ntp_degraded');
  }

  let status: OverallHealthState = 'ok';

  if (reasons.length === 0) {
    status = 'ok';
  } else if (reasons.length === 1 && reasons[0] === 'ntp_initializing') {
    status = 'initializing';
  } else if (reasons.includes('csv_sink_shutting_down')) {
    status = 'shutting_down';
  } else {
    status = 'degraded';
  }

  return {
    healthy: sinkHealthy && ntpHealthy,
    status,
    reasons,
    components: {
      csvSink: csvStatus,
      ntp: ntpStatus,
    },
  };
};

router.use(logCapture);

router.get('/', (_req, res) => {
  const csvStatus = csvSink.getHealthStatus();
  const ntpStatus = ntpMonitor.getStatus();
  const overall = deriveOverallHealth(csvStatus, ntpStatus);

  const response = {
    status: overall.status,
    healthy: overall.healthy,
    timestamp: new Date().toISOString(),
    reasons: overall.reasons,
    components: {
      csv_sink: {
        healthy: csvStatus.healthy,
        state: csvStatus.state,
        shutting_down: csvStatus.shuttingDown,
        last_error: csvStatus.lastError,
        last_success_at: csvStatus.lastSuccessAt ? csvStatus.lastSuccessAt.toISOString() : null,
        pending_writes: csvStatus.pendingWrites,
        total_written: csvStatus.totalWritten,
      },
      ntp: {
        disabled: ntpStatus.disabled,
        healthy: ntpStatus.healthy,
        state: ntpStatus.state,
        http_status: ntpStatus.httpStatus,
        percentile_ms: ntpStatus.percentileMs,
        percentile_rank: ntpStatus.percentileRank,
        threshold_ms: ntpStatus.thresholdMs,
        sample_count: ntpStatus.sampleCount,
        last_offset_ms: ntpStatus.lastOffsetMs,
        last_error: ntpStatus.lastError,
        last_check_at: ntpStatus.lastCheck ? ntpStatus.lastCheck.toISOString() : null,
      },
    },
  };

  res.status(overall.healthy ? 200 : 503).json(response);
});

export { router };
export default router;
