import { detectTimeDeviation } from '../../../src/sim/detector/timeDeviationDetector';

type SyntheticEvent = {
  timestamp: string;
  event: string;
  deltaSeconds?: number;
  uid?: string;
  metadata?: { op_category?: string };
};

const buildSequence = (deltas: number[], baseTime = '2024-01-01T00:00:00.000Z'): SyntheticEvent[] => {
  const events: SyntheticEvent[] = [
    { timestamp: baseTime, event: 'start', deltaSeconds: 0 },
  ];
  let current = new Date(baseTime).getTime();
  deltas.forEach((delta, index) => {
    current += delta * 1000;
    events.push({
      timestamp: new Date(current).toISOString(),
      event: `evt-${index}`,
      deltaSeconds: delta,
    });
  });
  return events;
};

const createDeterministicRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
};

const sampleGeneralizedPareto = (rng: () => number, xi: number, beta: number): number => {
  const u = Math.min(Math.max(rng(), 1e-12), 1 - 1e-12);
  if (Math.abs(xi) < 1e-6) {
    return -beta * Math.log(1 - u);
  }
  return (beta / xi) * (Math.pow(1 - u, -xi) - 1);
};

const buildGroupedSequence = (
  uid: string,
  category: string,
  deltas: number[],
  baseTime = '2024-01-01T00:00:00.000Z',
  startIndex = 0,
): SyntheticEvent[] => {
  const events: SyntheticEvent[] = [
    {
      timestamp: baseTime,
      event: `start-${uid}-${startIndex}`,
      deltaSeconds: 0,
      uid,
      metadata: { op_category: category },
    },
  ];
  let current = new Date(baseTime).getTime();
  deltas.forEach((delta, index) => {
    current += delta * 1000;
    events.push({
      timestamp: new Date(current).toISOString(),
      event: `evt-${uid}-${startIndex + index}`,
      deltaSeconds: delta,
      uid,
      metadata: { op_category: category },
    });
  });
  return events;
};

describe('detectTimeDeviation', () => {
  it('quantileベースで長いΔtを異常検知し、しきい値を返す', () => {
    const baseline = buildSequence([2, 2, 2, 2]);
    const target = buildSequence([2, 2, 20, 2]);

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      quantile: 0.95,
    });

    expect(result.events).toHaveLength(target.length);
    expect(result.thresholdSeconds).toBeCloseTo(2, 5);
    expect(result.thresholdLowerSeconds).toBeCloseTo(2, 5);
    expect(result.diagnostics.quantile).toBeCloseTo(0.95, 5);

    const anomaly = result.events[3];
    expect(anomaly.timeDeviationFlag).toBe(true);
    expect(anomaly.timeDeviationObservedDeltaSeconds).toBeCloseTo(20, 5);
    expect(anomaly.timeDeviationScore).toBeCloseTo(18, 5);
    expect(anomaly.timeDeviationThresholdSeconds).toBeCloseTo(result.thresholdSeconds, 5);
    expect(anomaly.timeDeviationThresholdLowerSeconds).toBeCloseTo(result.thresholdLowerSeconds, 5);
    expect(anomaly.tau_hi).toBeCloseTo(result.thresholdSeconds, 5);
    expect(anomaly.tau_lo).toBeCloseTo(result.thresholdLowerSeconds, 5);
    expect(anomaly.s_Q).toBeCloseTo(10, 5);
  });

  it('サンプル不足時はフォールバックしきい値を使用する', () => {
    const sequence = buildSequence([8]);

    const result = detectTimeDeviation(sequence, {
      minSamples: 10,
      fallbackThresholdSeconds: 5,
    });

    expect(result.events).toHaveLength(sequence.length);
    expect(result.thresholdSeconds).toBe(5);
    expect(result.thresholdLowerSeconds).toBe(5);
    expect(result.events[1].timeDeviationFlag).toBe(true);
    expect(result.events[1].timeDeviationScore).toBeCloseTo(3, 5);
    expect(result.events[1].tau_hi).toBe(5);
    expect(result.events[1].tau_lo).toBe(5);
    expect(result.events[1].s_Q).toBeCloseTo(1.6, 5);
    expect(result.diagnostics.fallbackApplied).toBe(true);
  });

  it('対数ヒストグラムOtsu法で多峰性Δtからしきい値を推定する', () => {
    const baseline = buildSequence([
      1.0,
      1.1,
      0.9,
      1.2,
      1.0,
      1.1,
      0.95,
      1.05,
      9.5,
      10.2,
      11.1,
      9.8,
    ]);
    const target = buildSequence([1.0, 1.1, 1.0, 12.5, 1.0]);

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      method: 'otsu',
    });

    const minBaseline = result.diagnostics.baselineMinSeconds ?? 0;
    const maxBaseline = result.diagnostics.baselineMaxSeconds ?? 0;
    expect(maxBaseline).toBeGreaterThan(minBaseline);
    expect(result.thresholdSeconds).toBeGreaterThan(minBaseline);
    expect(result.thresholdSeconds).toBeLessThan(maxBaseline);
    expect(result.thresholdLowerSeconds).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.otsu?.histogram?.method).toBe('log');
    expect(result.diagnostics.otsu?.histogram?.counts.length).toBeGreaterThan(0);

    const anomaly = result.events[4];
    expect(anomaly.timeDeviationFlag).toBe(true);
    expect(anomaly.timeDeviationObservedDeltaSeconds).toBeCloseTo(12.5, 5);
    expect((anomaly.tau_hi ?? 0)).toBeGreaterThan(minBaseline);
    expect((anomaly.tau_lo ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it('Knee距離リファインメントでOtsuより高いτを選択する', () => {
    const baseline = buildSequence([
      0.6,
      0.7,
      0.8,
      0.9,
      1.0,
      1.1,
      3.0,
      3.2,
      3.5,
      10.0,
      11.5,
      13.0,
      15.0,
    ]);
    const target = buildSequence([0.8, 1.0, 3.1, 14.0, 0.9]);

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      method: 'knee',
    });

    const otsuThreshold = result.diagnostics.otsu?.thresholdSeconds ?? 0;
    const kneeThreshold = result.diagnostics.knee?.thresholdSeconds ?? 0;
    expect(result.diagnostics.otsu).not.toBeNull();
    expect(result.diagnostics.knee).not.toBeNull();
    const combinedThreshold = Math.max(otsuThreshold, kneeThreshold);
    expect(result.thresholdSeconds).toBeCloseTo(combinedThreshold, 6);
    expect(combinedThreshold).toBeGreaterThan(result.diagnostics.baselineMinSeconds ?? 0);
    expect(result.thresholdLowerSeconds).toBeGreaterThanOrEqual(0);

    const anomaly = result.events[4];
    expect(anomaly.timeDeviationFlag).toBe(true);
    expect(anomaly.timeDeviationObservedDeltaSeconds).toBeCloseTo(14.0, 5);
    expect(result.diagnostics.knee?.distance ?? 0).toBeGreaterThan(0);
    expect((anomaly.tau_hi ?? 0)).toBeGreaterThan(result.diagnostics.baselineMinSeconds ?? 0);
    expect((anomaly.tau_lo ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it('ユーザ×カテゴリ単位のτで上下逸脱を識別する', () => {
    const baseline = [
      ...buildGroupedSequence('user-a', 'AUTH', [1.5, 1.6, 1.4, 1.5, 1.55, 1.45]),
      ...buildGroupedSequence('user-b', 'READ', [4.5, 4.6, 4.4, 4.5, 4.7, 4.55], '2024-01-02T00:00:00.000Z'),
    ];
    const target = [
      ...buildGroupedSequence('user-a', 'AUTH', [1.5, 5.0], '2024-02-01T00:00:00.000Z'),
      ...buildGroupedSequence('user-b', 'READ', [4.5, 0.5], '2024-02-01T00:10:00.000Z'),
    ];

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      quantileUpper: 0.9,
      quantileLower: 0.1,
    });

    const groupThresholds = result.diagnostics.groupThresholds ?? {};
    expect(groupThresholds['user-a||AUTH']).toBeDefined();
    expect(groupThresholds['user-b||READ']).toBeDefined();
    const authTau = groupThresholds['user-a||AUTH']!;
    const readTau = groupThresholds['user-b||READ']!;
    expect(authTau.tauHiSeconds).toBeLessThan(readTau.tauHiSeconds);
    expect(readTau.tauLoSeconds).toBeGreaterThan(0);

    const upperEvent = result.events.find(
      (event) => event.uid === 'user-a' && (event.timeDeviationObservedDeltaSeconds ?? 0) > 4,
    );
    expect(upperEvent).toBeDefined();
    expect(upperEvent?.timeDeviationFlag).toBe(true);
    expect(upperEvent?.tau_hi ?? 0).toBeGreaterThan(0);
    expect(upperEvent?.s_Q ?? 0).toBeGreaterThan(1);

    const lowerEvent = result.events.find(
      (event) => {
        const delta = event.timeDeviationObservedDeltaSeconds ?? 0;
        return event.uid === 'user-b' && delta > 0 && delta < 1;
      },
    );
    expect(lowerEvent).toBeDefined();
    expect(lowerEvent?.timeDeviationFlag).toBe(true);
    expect(lowerEvent?.timeDeviationObservedDeltaSeconds ?? 0).toBeCloseTo(0.5, 5);
    expect((lowerEvent?.tau_lo ?? 0)).toBeGreaterThan(lowerEvent?.timeDeviationObservedDeltaSeconds ?? 0);
    expect(lowerEvent?.s_Q ?? 0).toBeGreaterThan(1);
  });

  it('SPOT尾部フィットでξ>0のキャリブレーションを反映し、メタデータを伝搬する', () => {
    const rng = createDeterministicRng(98765);
    const body = Array.from({ length: 160 }, () => 0.8 + rng() * 0.4);
    const tail = Array.from({ length: 40 }, () => 1.5 + sampleGeneralizedPareto(rng, 0.25, 0.6));
    const baselineDeltas = [...body, ...tail];
    const baseline = buildSequence(baselineDeltas);
    const anomalyDelta = 1.5 + sampleGeneralizedPareto(rng, 0.25, 0.6) + 2.5;
    const target = buildSequence([...body.slice(0, 10), anomalyDelta, ...body.slice(10, 20)]);

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      method: 'spot',
      quantileUpper: 0.9,
      quantileLower: 0.05,
    });

    const calibration = result.diagnostics.spot;
    expect(calibration).not.toBeNull();
    expect((calibration?.uSeconds ?? 0)).toBeGreaterThan(1);
    expect((calibration?.tauTSeconds ?? 0)).toBeGreaterThanOrEqual(calibration?.uSeconds ?? 0);
    expect(Math.abs(calibration?.xi ?? 0)).toBeGreaterThan(0.05);
    const exceedanceRate = baselineDeltas.filter((delta) => delta > (calibration?.tauTSeconds ?? Number.MAX_VALUE)).length
      / baselineDeltas.length;
    expect(exceedanceRate).toBeLessThanOrEqual((calibration?.qStar ?? 0) + 0.01);
    expect(result.thresholdSeconds).toBeCloseTo(calibration?.tauTSeconds ?? 0, 8);
    const flagged = result.events.find((event) => event.timeDeviationFlag === true);
    expect(flagged?.timeDeviationCalibrationTauTSeconds).toBeCloseTo(calibration?.tauTSeconds ?? 0, 6);
    expect(flagged?.timeDeviationCalibrationPRef).toBeCloseTo(calibration?.pRef ?? 0, 6);
    expect(flagged?.timeDeviationCalibrationUSeconds).toBeCloseTo(calibration?.uSeconds ?? 0, 6);
  });

  it('SPOTキャリブレーションはξ≈0の極限でもτ_tと尾部確率を整合させる', () => {
    const rng = createDeterministicRng(24680);
    const body = Array.from({ length: 360 }, () => 0.6 + rng() * 0.3);
    const tail = Array.from({ length: 120 }, () => 1.2 + sampleGeneralizedPareto(rng, 1e-6, 0.5));
    const baselineDeltas = [...body, ...tail];
    const baseline = buildSequence(baselineDeltas);
    const anomalyDelta = 1.2 + sampleGeneralizedPareto(rng, 1e-6, 0.5) + 1.8;
    const target = buildSequence([...body.slice(0, 8), anomalyDelta, ...body.slice(8, 18)]);

    const result = detectTimeDeviation(target, {
      baselineSequence: baseline,
      method: 'spot',
      quantileUpper: 0.92,
      quantileLower: 0.05,
    });

    const calibration = result.diagnostics.spot;
    expect(calibration).not.toBeNull();
    expect(Math.abs(calibration?.xi ?? 1)).toBeLessThan(0.12);
    expect(calibration?.beta ?? 0).toBeGreaterThan(0);
    const ratio = (calibration?.pRef ?? 0) / Math.max(calibration?.qStar ?? 1e-6, 1e-6);
    const expectedTau = Math.max(
      (calibration?.uSeconds ?? 0) + (calibration?.beta ?? 0) * Math.log(Math.max(ratio, 1e-6)),
      calibration?.uSeconds ?? 0,
    );
    expect(result.thresholdSeconds).toBeCloseTo(expectedTau, 4);
    const exceedanceRate = baselineDeltas.filter((delta) => delta > (calibration?.tauTSeconds ?? Number.MAX_VALUE)).length
      / baselineDeltas.length;
    expect(exceedanceRate).toBeLessThanOrEqual((calibration?.qStar ?? 0) + 0.01);
    const flagged = result.events.find((event) => event.timeDeviationFlag === true);
    expect(flagged?.timeDeviationCalibrationXi ?? 0).toBeCloseTo(calibration?.xi ?? 0, 6);
    expect(flagged?.timeDeviationCalibrationBeta ?? 0).toBeCloseTo(calibration?.beta ?? 0, 6);
  });
});
