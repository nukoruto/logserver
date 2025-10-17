import { detectTimeDeviation } from '../../src/sim/detector/timeDeviationDetector';

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
    expect(anomaly.timeDeviationRawFlag).toBe(true);
    expect(anomaly.timeDeviationVotingFlag).toBe(true);
    expect(anomaly.timeDeviationFlag).toBe(true);
    expect(anomaly.timeDeviationObservedDeltaSeconds).toBeCloseTo(20, 5);
    expect(anomaly.timeDeviationThresholdSeconds).toBeCloseTo(2, 5);
    expect(anomaly.timeDeviationScore).toBeCloseTo(18, 5);

    const normalEvent = detected[2];
    expect(normalEvent.timeDeviationRawFlag).toBe(false);
    expect(normalEvent.timeDeviationVotingFlag).toBe(false);
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

  it('K-of-N 投票により短時間のバーストをまとめて検知する', () => {
    const baseline = Array.from({ length: 6 }).map((_, index) => ({
      timestamp: new Date(2024, 0, 1, 0, 0, index * 2).toISOString(),
    }));

    const sequence = [
      { timestamp: '2024-01-01T00:00:00.000Z', event: 'login' },
      { timestamp: '2024-01-01T00:00:02.000Z', event: 'browse' },
      { timestamp: '2024-01-01T00:00:08.000Z', event: 'edit', deltaSeconds: 6 },
      { timestamp: '2024-01-01T00:00:10.000Z', event: 'view', deltaSeconds: 2 },
      { timestamp: '2024-01-01T00:00:16.000Z', event: 'save', deltaSeconds: 6 },
      { timestamp: '2024-01-01T00:00:18.000Z', event: 'logout', deltaSeconds: 2 },
    ];

    const detected = detectTimeDeviation(sequence, {
      baselineSequence: baseline,
      quantile: 0.9,
      voting: { k: 2, n: 3 },
    });

    expect(detected[2].timeDeviationRawFlag).toBe(true);
    expect(detected[2].timeDeviationVotingFlag).toBe(false);
    expect(detected[2].timeDeviationFlag).toBe(false);

    expect(detected[4].timeDeviationRawFlag).toBe(true);
    expect(detected[4].timeDeviationVotingFlag).toBe(true);
    expect(detected[4].timeDeviationFlag).toBe(true);
  });

  it('ヒステリシス保持により解除が遅延する', () => {
    const sequence = [
      { timestamp: '2024-04-01T00:00:00.000Z', event: 'login' },
      { timestamp: '2024-04-01T00:00:02.000Z', event: 'browse' },
      { timestamp: '2024-04-01T00:00:14.000Z', event: 'edit', deltaSeconds: 12 },
      { timestamp: '2024-04-01T00:00:16.000Z', event: 'save', deltaSeconds: 2 },
      { timestamp: '2024-04-01T00:00:18.000Z', event: 'logout', deltaSeconds: 2 },
    ];

    const detected = detectTimeDeviation(sequence, {
      quantile: 0.75,
      voting: { k: 1, n: 1 },
      hysteresis: { holdCount: 2 },
    });

    expect(detected[2].timeDeviationFlag).toBe(true);
    expect(detected[2].timeDeviationHoldRemaining).toBe(2);
    expect(detected[3].timeDeviationFlag).toBe(true);
    expect(detected[3].timeDeviationHoldRemaining).toBe(1);
    expect(detected[4].timeDeviationFlag).toBe(true);
    expect(detected[4].timeDeviationHoldRemaining).toBe(0);
  });
});
