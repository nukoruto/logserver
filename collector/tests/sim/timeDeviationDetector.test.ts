const { detectTimeDeviation } = require('../../src/sim/detector/timeDeviationDetector');

describe('detectTimeDeviation', () => {
  it('基準系列の分位点を用いて長いΔtを異常検知する', () => {
    const baseline = [
      { timestamp: '2024-01-01T00:00:00.000Z' },
      { timestamp: '2024-01-01T00:00:02.000Z' },
      { timestamp: '2024-01-01T00:00:04.000Z' },
      { timestamp: '2024-01-01T00:00:06.000Z' },
      { timestamp: '2024-01-01T00:00:08.000Z' },
    ];

    const target = [
      { timestamp: '2024-01-01T00:00:00.000Z', event: 'login' },
      { timestamp: '2024-01-01T00:00:02.000Z', event: 'browse' },
      { timestamp: '2024-01-01T00:00:04.000Z', event: 'edit' },
      { timestamp: '2024-01-01T00:00:24.000Z', event: 'save', deltaSeconds: 20 },
      { timestamp: '2024-01-01T00:00:26.000Z', event: 'logout' },
    ];

    const detected = detectTimeDeviation(target, {
      baselineSequence: baseline,
      quantile: 0.95,
    });

    expect(detected).toHaveLength(target.length);
    const anomaly = detected[3];
    expect(anomaly.timeDeviationFlag).toBe(true);
    expect(anomaly.timeDeviationObservedDeltaSeconds).toBeCloseTo(20, 5);
    expect(anomaly.timeDeviationThresholdSeconds).toBeCloseTo(2, 5);
    expect(anomaly.timeDeviationScore).toBeCloseTo(18, 5);

    const normalEvent = detected[2];
    expect(normalEvent.timeDeviationFlag).toBe(false);
    expect(normalEvent.timeDeviationObservedDeltaSeconds).toBeCloseTo(2, 5);
  });

  it('サンプル不足時はフォールバックしきい値を使用する', () => {
    const sequence = [
      { timestamp: '2024-02-01T00:00:00.000Z', event: 'login' },
      { timestamp: '2024-02-01T00:00:08.000Z', event: 'logout', deltaSeconds: 8 },
    ];

    const detected = detectTimeDeviation(sequence, {
      minSamples: 10,
      fallbackThresholdSeconds: 5,
    });

    expect(detected).toHaveLength(sequence.length);
    expect(detected[1].timeDeviationThresholdSeconds).toBe(5);
    expect(detected[1].timeDeviationFlag).toBe(true);
    expect(detected[1].timeDeviationScore).toBeCloseTo(3, 5);
  });
});
