import { detectTimeDeviation, resolveThreshold } from '../../src/sim/detector/timeDeviationDetector';

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
    expect(anomaly.tau_hi).toBeCloseTo(2, 5);
    expect(anomaly.tau_lo).toBeCloseTo(2, 5);
    expect(anomaly.s_Q).toBeGreaterThan(1);

    const normalEvent = detected[2];
    expect(normalEvent.timeDeviationFlag).toBe(false);
    expect(normalEvent.timeDeviationObservedDeltaSeconds).toBeCloseTo(2, 5);
    expect(normalEvent.tau_hi).toBeCloseTo(2, 5);
    expect(normalEvent.s_Q).toBeCloseTo(1, 5);
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
    const flagged = detected[1];
    expect(flagged.timeDeviationThresholdSeconds).toBe(5);
    expect(flagged.tau_hi).toBe(5);
    expect(flagged.tau_lo).toBe(0);
    expect(flagged.timeDeviationFlag).toBe(true);
    expect(flagged.timeDeviationScore).toBeCloseTo(3, 5);
    expect(flagged.s_Q).toBeCloseTo(8 / 5, 5);
  });

  it('ユーザとカテゴリごとのτを適用し、無い場合はグローバルを使用する', () => {
    const baseline = [
      { timestamp: '2024-01-01T00:00:00.000Z', uid: 'user-a', metadata: { op_category: 'READ' } },
      { timestamp: '2024-01-01T00:00:01.000Z', uid: 'user-a', metadata: { op_category: 'READ' }, deltaSeconds: 2 },
      { timestamp: '2024-01-01T00:00:02.000Z', uid: 'user-a', metadata: { op_category: 'READ' }, deltaSeconds: 3 },
      { timestamp: '2024-01-01T00:00:03.000Z', uid: 'user-a', metadata: { op_category: 'READ' }, deltaSeconds: 2.5 },
      { timestamp: '2024-01-01T00:00:04.000Z', uid: 'user-a', metadata: { op_category: 'READ' }, deltaSeconds: 2 },
      { timestamp: '2024-01-01T00:05:00.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' } },
      { timestamp: '2024-01-01T00:05:01.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' }, deltaSeconds: 7 },
      { timestamp: '2024-01-01T00:05:02.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' }, deltaSeconds: 8 },
      { timestamp: '2024-01-01T00:05:03.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' }, deltaSeconds: 9 },
      { timestamp: '2024-01-01T00:05:04.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' }, deltaSeconds: 7.5 },
    ];

    const target = [
      { timestamp: '2024-02-01T00:00:00.000Z', uid: 'user-a', metadata: { op_category: 'READ' } },
      { timestamp: '2024-02-01T00:00:01.000Z', uid: 'user-a', metadata: { op_category: 'READ' }, deltaSeconds: 4 },
      { timestamp: '2024-02-01T00:00:02.000Z', uid: 'user-b', metadata: { op_category: 'WRITE' }, deltaSeconds: 8 },
      { timestamp: '2024-02-01T00:00:03.000Z', uid: 'user-c', metadata: { op_category: 'READ' }, deltaSeconds: 12 },
    ];

    const options = { quantileUpper: 0.9, quantileLower: 0.1, minSamples: 3, baselineSequence: baseline } as const;
    const detected = detectTimeDeviation(target, options);

    const userAnomaly = detected[1];
    expect(userAnomaly.timeDeviationFlag).toBe(true);
    expect(userAnomaly.tau_hi).toBeLessThan(3.5);
    expect(userAnomaly.s_Q ?? 0).toBeGreaterThan(1.3);

    const userNormal = detected[2];
    expect(userNormal.timeDeviationFlag).toBe(false);
    expect(userNormal.tau_hi ?? 0).toBeGreaterThan(userAnomaly.tau_hi ?? 0);
    expect(userNormal.s_Q).toBeCloseTo(1, 5);

    const fallback = detected[3];
    const sameUidDeltas: number[] = [];
    for (let index = 1; index < baseline.length; index += 1) {
      const current = baseline[index] as { deltaSeconds?: number; uid?: string };
      const previous = baseline[index - 1] as { uid?: string };
      if (current.uid && previous.uid && current.uid === previous.uid && Number.isFinite(current.deltaSeconds)) {
        sameUidDeltas.push(Number(current.deltaSeconds));
      }
    }
    const globalPair = resolveThreshold(sameUidDeltas, options);
    if (!globalPair) {
      throw new Error('global thresholds must be available');
    }
    expect(fallback.tau_hi).toBeCloseTo(globalPair.tauHi, 5);
    expect(fallback.tau_lo).toBeCloseTo(globalPair.tauLo, 5);
  });

  it('上側と下側の逸脱に対してτとs_Qを付与する', () => {
    const baseline = [
      { timestamp: '2024-03-01T00:00:00.000Z', uid: 'user-l', metadata: { op_category: 'READ' } },
      { timestamp: '2024-03-01T00:00:01.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 5 },
      { timestamp: '2024-03-01T00:00:02.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 5 },
      { timestamp: '2024-03-01T00:00:03.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 5 },
      { timestamp: '2024-03-01T00:00:04.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 5 },
    ];

    const target = [
      { timestamp: '2024-03-02T00:00:00.000Z', uid: 'user-l', metadata: { op_category: 'READ' } },
      { timestamp: '2024-03-02T00:00:01.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 9 },
      { timestamp: '2024-03-02T00:00:02.000Z', uid: 'user-l', metadata: { op_category: 'READ' }, deltaSeconds: 2 },
    ];

    const detected = detectTimeDeviation(target, {
      baselineSequence: baseline,
      quantileUpper: 0.8,
      quantileLower: 0.2,
      minSamples: 3,
    });

    expect(detected[0].timeDeviationFlag).toBe(false);
    expect(detected[0].s_Q).toBeCloseTo(1, 5);

    const upper = detected[1];
    expect(upper.timeDeviationFlag).toBe(true);
    expect(upper.timeDeviationScore).toBeGreaterThan(0);
    expect(upper.s_Q ?? 0).toBeGreaterThan(1);

    const lower = detected[2];
    expect(lower.timeDeviationFlag).toBe(true);
    expect(lower.timeDeviationScore).toBeGreaterThan(0);
    expect(lower.s_Q ?? 0).toBeGreaterThan(1);
    expect(lower.timeDeviationThresholdSeconds).toBeCloseTo(upper.timeDeviationThresholdSeconds ?? 0, 5);
  });
});
