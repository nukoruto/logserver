const express = require('express');
const logCapture = require('../middleware/logCapture');
const { ntpMonitor } = require('../services/ntpMonitor');

const router = express.Router();

router.use(logCapture);

router.get('/', (_req, res) => {
  const status = ntpMonitor.getStatus();
  const payload = {
    status: status.state,
    healthy: status.healthy,
    timestamp: new Date().toISOString(),
    ntp: {
      disabled: status.disabled,
      percentile_ms: status.percentileMs,
      percentile_rank: status.percentileRank,
      threshold_ms: status.thresholdMs,
      sample_count: status.sampleCount,
      last_offset_ms: status.lastOffsetMs,
      last_error: status.lastError,
      last_check_at: status.lastCheck ? status.lastCheck.toISOString() : null,
    },
  };

  res.status(status.httpStatus).json(payload);
});

module.exports = router;
