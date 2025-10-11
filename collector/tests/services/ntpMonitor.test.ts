import { NtpMonitor } from '../../src/services/ntpMonitor';

describe('NtpMonitor', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reports disabled state without scheduling checks', () => {
    const checkFn = jest.fn<Promise<number>, []>(() => Promise.resolve(0));
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const monitor = new NtpMonitor({ disabled: true, checkFn, logger });

    monitor.start();

    expect(checkFn).not.toHaveBeenCalled();
    const status = monitor.getStatus();
    expect(status.disabled).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.state).toBe('disabled');
    expect(status.httpStatus).toBe(200);
  });

  it('raises warnings when percentile exceeds threshold and recovers afterwards', async () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const checkFn = jest
      .fn<Promise<number>, []>()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(200)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(35)
      .mockResolvedValueOnce(40);

    const monitor = new NtpMonitor({
      disabled: false,
      checkFn,
      logger,
      maxSamples: 5,
      warnThresholdMs: 50,
      warnPercentile: 95,
    });

    for (let i = 0; i < 5; i += 1) {
      await monitor.checkNow();
    }

    const degraded = monitor.getStatus();
    expect(degraded.state).toBe('degraded');
    expect(degraded.healthy).toBe(false);
    expect(degraded.httpStatus).toBe(503);
    expect(degraded.percentileMs).not.toBeNull();
    expect((degraded.percentileMs ?? 0) > 50).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('NTP offset percentile exceeded threshold', expect.any(Object));

    for (let i = 0; i < 5; i += 1) {
      await monitor.checkNow();
    }

    const recovered = monitor.getStatus();
    expect(recovered.state).toBe('ok');
    expect(recovered.healthy).toBe(true);
    expect(recovered.httpStatus).toBe(200);
    expect((recovered.percentileMs ?? 0) < 50).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('NTP offset percentile recovered within threshold', expect.any(Object));
  });
});
