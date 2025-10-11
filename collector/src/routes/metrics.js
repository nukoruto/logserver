const express = require('express');
const sanitize = require('../middleware/sanitize');
const logCapture = require('../middleware/logCapture');
const opCategory = require('../middleware/opCategory');
const { csvSink } = require('../index');
const { ntpMonitor } = require('../services/ntpMonitor');

const router = express.Router();

router.use(sanitize);
router.use(logCapture);
router.use(opCategory('READ'));

const formatValue = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'NaN';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'Inf' : '-Inf';
  }
  return value.toString();
};

const formatPrometheusMetrics = (snapshot) => {
  const lines = [
    '# HELP logserver_written_total Total log entries successfully written to the CSV sink.',
    '# TYPE logserver_written_total counter',
    `logserver_written_total ${formatValue(snapshot.writtenTotal)}`,
    '# HELP logserver_queue_depth Number of log entries currently queued for CSV persistence.',
    '# TYPE logserver_queue_depth gauge',
    `logserver_queue_depth ${formatValue(snapshot.queueDepth)}`,
    '# HELP logserver_retry_queue_depth Number of log entries waiting in the retry buffer.',
    '# TYPE logserver_retry_queue_depth gauge',
    `logserver_retry_queue_depth ${formatValue(snapshot.retryQueueDepth)}`,
    '# HELP logserver_drop_total Total log entries dropped due to retry queue overflow or shutdown.',
    '# TYPE logserver_drop_total counter',
    `logserver_drop_total ${formatValue(snapshot.dropTotal)}`,
    '# HELP logserver_ntp_offset_ms Most recent absolute NTP clock offset in milliseconds.',
    '# TYPE logserver_ntp_offset_ms gauge',
    `logserver_ntp_offset_ms ${formatValue(snapshot.ntpOffsetMs)}`,
  ];

  return lines.join('\n');
};

router.get('/', (_req, res) => {
  const metrics = csvSink.getMetrics();
  const ntpStatus = ntpMonitor.getStatus();

  const snapshot = {
    writtenTotal: metrics.totalWritten,
    queueDepth: metrics.queueDepth,
    retryQueueDepth: metrics.retryQueueDepth,
    dropTotal: metrics.dropTotal,
    ntpOffsetMs: typeof ntpStatus.lastOffsetMs === 'number' ? ntpStatus.lastOffsetMs : null,
  };

  const body = formatPrometheusMetrics(snapshot);

  res
    .status(200)
    .type('text/plain; version=0.0.4; charset=utf-8')
    .send(`${body}\n`);
});

module.exports = router;
module.exports.formatPrometheusMetrics = formatPrometheusMetrics;
module.exports.default = router;
module.exports.__esModule = true;
