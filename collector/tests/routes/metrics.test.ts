import { formatPrometheusMetrics, type MetricsSnapshot } from '../../src/routes/metrics';

describe('metrics route helpers', () => {
  it('formats Prometheus metrics with help and type metadata', () => {
    const snapshot: MetricsSnapshot = {
      writtenTotal: 42,
      queueDepth: 3,
      retryQueueDepth: 1,
      dropTotal: 2,
      ntpOffsetMs: 1.25,
    };

    const rendered = formatPrometheusMetrics(snapshot);

    expect(rendered).toContain('# HELP logserver_written_total');
    expect(rendered).toContain('# TYPE logserver_written_total counter');
    expect(rendered).toContain('logserver_written_total 42');
    expect(rendered).toContain('logserver_queue_depth 3');
    expect(rendered).toContain('logserver_ntp_offset_ms 1.25');
  });

  it('falls back to NaN when the NTP offset is not yet available', () => {
    const snapshot: MetricsSnapshot = {
      writtenTotal: 0,
      queueDepth: 0,
      retryQueueDepth: 0,
      dropTotal: 0,
      ntpOffsetMs: null,
    };

    const rendered = formatPrometheusMetrics(snapshot);

    expect(rendered).toContain('logserver_ntp_offset_ms NaN');
  });
});
