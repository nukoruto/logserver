import { detectTimeDeviation, createThresholdCache } from '../../src/sim/detector/timeDeviationDetector';

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
    expect(anomaly.timeDeviationThresholdTier).toBe('global');
    expect(anomaly.metadata?.time_deviation).toMatchObject({ threshold_tier: 'global', sample_count: 6 });

    const normalEvent = detected[2];
    expect(normalEvent.timeDeviationFlag).toBe(false);
    expect(normalEvent.timeDeviationObservedDeltaSeconds).toBeCloseTo(2, 5);
    expect(normalEvent.timeDeviationThresholdTier).toBe('global');
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
    expect(detected[1].timeDeviationThresholdTier).toBe('global');
    expect(detected[1].metadata?.time_deviation).toMatchObject({ threshold_tier: 'global', sample_count: 0 });
  });

  it('十分なサンプルがある(uid, op_category)ではグループ統計を使用する', () => {
    const cache = createThresholdCache();
    cache.record('user-a', 'AUTH', 2.0);
    cache.record('user-a', 'AUTH', 2.2);
    cache.record('user-a', 'AUTH', 2.4);

    const sequence = [
      {
        timestamp: '2024-04-01T00:00:00.000Z',
        uid: 'user-a',
        metadata: { op_category: 'AUTH' },
      },
      {
        timestamp: '2024-04-01T00:00:02.000Z',
        uid: 'user-a',
        deltaSeconds: 2.6,
        metadata: { op_category: 'AUTH' },
      },
      {
        timestamp: '2024-04-01T00:00:04.500Z',
        uid: 'user-a',
        deltaSeconds: 2.5,
        metadata: { op_category: 'AUTH' },
      },
    ];

    const detected = detectTimeDeviation(sequence, {
      statsCache: cache,
      minSamples: 3,
      quantile: 0.95,
    });

    expect(detected[1].timeDeviationThresholdTier).toBe('group');
    expect(detected[1].timeDeviationSampleCount).toBe(3);
    expect(detected[1].metadata?.time_deviation).toMatchObject({ threshold_tier: 'group', sample_count: 3 });
    expect(detected[1].timeDeviationFlag).toBe(true);
  });

  it('グループが不足しても uid 単位の統計にフォールバックする', () => {
    const cache = createThresholdCache();
    cache.record('user-b', 'AUTH', 1.0);
    cache.record('user-b', 'AUTH', 1.2);
    cache.record('user-b', 'READ', 1.1);

    const sequence = [
      {
        timestamp: '2024-04-02T00:00:00.000Z',
        uid: 'user-b',
        metadata: { op_category: 'UPDATE' },
      },
      {
        timestamp: '2024-04-02T00:00:01.400Z',
        uid: 'user-b',
        deltaSeconds: 1.4,
        metadata: { op_category: 'UPDATE' },
      },
    ];

    const detected = detectTimeDeviation(sequence, {
      statsCache: cache,
      minSamples: 3,
      quantile: 0.9,
    });

    expect(detected[1].timeDeviationThresholdTier).toBe('user');
    expect(detected[1].timeDeviationSampleCount).toBe(3);
    expect(detected[1].metadata?.time_deviation).toMatchObject({ threshold_tier: 'user', sample_count: 3 });
  });

  it('uid が不足してもグローバル統計にフォールバックする', () => {
    const cache = createThresholdCache();
    cache.seedGlobal([0.8, 1.0, 1.2]);

    const sequence = [
      {
        timestamp: '2024-04-03T00:00:00.000Z',
        uid: 'user-c',
        metadata: { op_category: 'AUTH' },
      },
      {
        timestamp: '2024-04-03T00:00:01.100Z',
        uid: 'user-c',
        deltaSeconds: 1.1,
        metadata: { op_category: 'AUTH' },
      },
    ];

    const detected = detectTimeDeviation(sequence, {
      statsCache: cache,
      minSamples: 3,
      quantile: 0.9,
    });

    expect(detected[1].timeDeviationThresholdTier).toBe('global');
    expect(detected[1].timeDeviationSampleCount).toBe(3);
    expect(detected[1].metadata?.time_deviation).toMatchObject({ threshold_tier: 'global', sample_count: 3 });
  });
});
