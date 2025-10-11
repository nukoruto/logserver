const express = require('express');
const sanitize = require('../middleware/sanitize');
const logCapture = require('../middleware/logCapture');
const opCategory = require('../middleware/opCategory');
const { csvSink } = require('../index');
const { ntpMonitor } = require('../services/ntpMonitor');

const router = express.Router();

const deriveOverallHealth = (csvStatus, ntpStatus) => {
  const sinkHealthy = csvStatus.healthy;
  const ntpHealthy = ntpStatus.disabled ? true : ntpStatus.healthy;

  const reasons = [];

  if (!sinkHealthy) {
    reasons.push(csvStatus.state === 'shutting_down' ? 'csv_sink_shutting_down' : 'csv_sink_unavailable');
  }

  if (!ntpHealthy) {
    reasons.push(ntpStatus.state === 'initializing' ? 'ntp_initializing' : 'ntp_degraded');
  }

  let status = 'ok';

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
  };
};

router.use(sanitize);
router.use(logCapture);
router.use(opCategory('READ'));

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

module.exports = router;
module.exports.deriveOverallHealth = deriveOverallHealth;
module.exports.default = router;
module.exports.__esModule = true;
