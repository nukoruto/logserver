import { deriveOverallHealth, type OverallHealthState } from '../../src/routes/health';
import type { CsvSinkHealthStatus } from '../../src/sink/csvSink';
import type { NtpHealthStatus } from '../../src/services/ntpMonitor';

const baseSinkStatus = (): CsvSinkHealthStatus => ({
  healthy: true,
  state: 'ok',
  shuttingDown: false,
  lastError: null,
  lastSuccessAt: new Date('2024-01-01T00:00:00.000Z'),
  pendingWrites: 0,
  totalWritten: 10,
});

const baseNtpStatus = (): NtpHealthStatus => ({
  disabled: false,
  healthy: true,
  state: 'ok',
  httpStatus: 200,
  percentileMs: 10,
  percentileRank: 95,
  thresholdMs: 50,
  sampleCount: 100,
  lastOffsetMs: 2,
  lastError: null,
  lastCheck: new Date('2024-01-01T00:00:00.000Z'),
});

describe('deriveOverallHealth', () => {
  const expectState = (state: OverallHealthState, expected: OverallHealthState) => {
    expect(state).toBe(expected);
  };

  it('returns ok when both subsystems are healthy', () => {
    const overall = deriveOverallHealth(baseSinkStatus(), baseNtpStatus());

    expect(overall.healthy).toBe(true);
    expectState(overall.status, 'ok');
    expect(overall.reasons).toHaveLength(0);
  });

  it('remains healthy when NTP checks are disabled', () => {
    const ntp = baseNtpStatus();
    ntp.disabled = true;
    ntp.healthy = false;
    ntp.state = 'disabled';
    const overall = deriveOverallHealth(baseSinkStatus(), ntp);

    expect(overall.healthy).toBe(true);
    expectState(overall.status, 'ok');
  });

  it('flags degradation when the CSV sink reports an error', () => {
    const sink = baseSinkStatus();
    sink.healthy = false;
    sink.state = 'degraded';
    sink.lastError = 'disk full';

    const overall = deriveOverallHealth(sink, baseNtpStatus());

    expect(overall.healthy).toBe(false);
    expectState(overall.status, 'degraded');
    expect(overall.reasons).toContain('csv_sink_unavailable');
  });

  it('signals initializing state when NTP samples are not ready', () => {
    const ntp = baseNtpStatus();
    ntp.healthy = false;
    ntp.state = 'initializing';
    ntp.httpStatus = 503;

    const overall = deriveOverallHealth(baseSinkStatus(), ntp);

    expect(overall.healthy).toBe(false);
    expectState(overall.status, 'initializing');
    expect(overall.reasons).toContain('ntp_initializing');
  });

  it('escalates to shutting_down when the sink is draining', () => {
    const sink = baseSinkStatus();
    sink.healthy = false;
    sink.state = 'shutting_down';
    sink.shuttingDown = true;

    const overall = deriveOverallHealth(sink, baseNtpStatus());

    expect(overall.healthy).toBe(false);
    expectState(overall.status, 'shutting_down');
    expect(overall.reasons).toContain('csv_sink_shutting_down');
  });
});
