import {
  detectTimeDeviation,
  resolveThreshold,
  extractDeltaSeries,
  type TimeDeviationOptions,
} from '../../src/sim/detector/timeDeviationDetector';

const createRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const buildSequenceFromDeltas = (deltas: readonly number[]): Array<{ timestamp: string; event: string }> => {
  const events: Array<{ timestamp: string; event: string }> = [];
  let current = Date.parse('2024-01-01T00:00:00.000Z');
  events.push({ timestamp: new Date(current).toISOString(), event: 'e0' });
  for (let index = 0; index < deltas.length; index += 1) {
    current += Math.max(deltas[index], 0) * 1000;
    events.push({ timestamp: new Date(current).toISOString(), event: `e${index + 1}` });
  }
  return events;
};

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

  it('SPOT 法は指数尾に対して τ_t と尾確率を安定化する', () => {
    const rng = createRng(0xdecaf);
    const expSample = (): number => -Math.log(1 - rng());
    const baselineDeltas = Array.from({ length: 5000 }, () => expSample());
    const baselineSequence = buildSequenceFromDeltas(baselineDeltas);
    const extractedBaseline = extractDeltaSeries(baselineSequence);

    const calibrationOptions: TimeDeviationOptions = {
      method: 'spot',
      quantile: 0.98,
      spotTailFraction: 0.05,
      spotTargetProbability: 0.01,
    };
    const calibrationCopy: TimeDeviationOptions = { ...calibrationOptions };
    const expectedThreshold = resolveThreshold(extractedBaseline, calibrationCopy);
    const meta = calibrationCopy.spotMetadata;
    expect(meta).toBeDefined();
    if (!meta) {
      throw new Error('SPOT metadata missing for exponential tail');
    }
    expect(expectedThreshold).toBeCloseTo(meta.tauT, 9);
    expect(Math.abs(meta.xi)).toBeLessThan(0.05);

    const exceedProb = extractedBaseline.filter((value) => value > meta.tauT).length / extractedBaseline.length;
    expect(exceedProb).toBeLessThanOrEqual(meta.qStar * 1.5);

    const evaluationSequence = buildSequenceFromDeltas([...baselineDeltas, meta.tauT * 1.25]);

    const detected = detectTimeDeviation(evaluationSequence, {
      method: 'spot',
      quantile: calibrationOptions.quantile,
      spotTailFraction: calibrationOptions.spotTailFraction,
      spotTargetProbability: calibrationOptions.spotTargetProbability,
      baselineSequence,
    });

    const lastEvent = detected[detected.length - 1];
    expect(lastEvent.timeDeviationFlag).toBe(true);
    expect(lastEvent.timeDeviationSpotTauTSeconds).toBeCloseTo(meta.tauT, 6);
    expect(lastEvent.timeDeviationSpotUSeconds).toBeCloseTo(meta.u, 6);
    expect(lastEvent.timeDeviationSpotXi).toBeCloseTo(meta.xi, 6);
    expect(lastEvent.timeDeviationSpotBeta).toBeCloseTo(meta.beta, 6);
    expect(lastEvent.timeDeviationSpotPRef).toBeCloseTo(meta.pRef, 6);
    expect(lastEvent.timeDeviationSpotQStar).toBeCloseTo(meta.qStar, 6);
    expect(lastEvent.timeDeviationSpotTailCount).toBe(meta.tailCount);
    expect(lastEvent.timeDeviationSpotSampleCount).toBe(meta.sampleCount);
  });

  it('SPOT 法は重い尾 (ξ > 0) に対して目標尾確率を制御する', () => {
    const rng = createRng(0x12345678);
    const baselineDeltas = Array.from({ length: 720 }, (_, index) => {
      if (index % 18 === 0) {
        return 5 + rng() * 2.5;
      }
      return 0.6 + rng() * 0.4;
    });
    const baselineSequence = buildSequenceFromDeltas(baselineDeltas);
    const extractedBaseline = extractDeltaSeries(baselineSequence);

    const calibrationOptions: TimeDeviationOptions = {
      method: 'spot',
      quantile: 0.95,
      spotTailFraction: 0.08,
      spotTargetProbability: 0.02,
    };
    const calibrationCopy: TimeDeviationOptions = { ...calibrationOptions };
    const expectedThreshold = resolveThreshold(extractedBaseline, calibrationCopy);
    const meta = calibrationCopy.spotMetadata;
    expect(meta).toBeDefined();
    if (!meta) {
      throw new Error('SPOT metadata missing for heavy tail');
    }
    expect(expectedThreshold).toBeCloseTo(meta.tauT, 9);
    expect(meta.xi).toBeGreaterThan(0.3);

    const exceedProb = extractedBaseline.filter((value) => value > meta.tauT).length / extractedBaseline.length;
    expect(exceedProb).toBeLessThanOrEqual(meta.qStar * 1.5);

    const evaluationSequence = buildSequenceFromDeltas([...baselineDeltas, meta.tauT * 1.8]);

    const detected = detectTimeDeviation(evaluationSequence, {
      method: 'spot',
      quantile: calibrationOptions.quantile,
      spotTailFraction: calibrationOptions.spotTailFraction,
      spotTargetProbability: calibrationOptions.spotTargetProbability,
      baselineSequence,
    });

    const lastEvent = detected[detected.length - 1];
    expect(lastEvent.timeDeviationFlag).toBe(true);
    expect(lastEvent.timeDeviationScore).toBeGreaterThan(0);
    expect(lastEvent.timeDeviationSpotTauTSeconds).toBeCloseTo(meta.tauT, 6);
    expect(lastEvent.timeDeviationSpotUSeconds).toBeCloseTo(meta.u, 6);
    expect(lastEvent.timeDeviationSpotXi).toBeCloseTo(meta.xi, 6);
    expect(lastEvent.timeDeviationSpotBeta).toBeCloseTo(meta.beta, 6);
    expect(lastEvent.timeDeviationSpotTailCount).toBe(meta.tailCount);
    expect(lastEvent.timeDeviationSpotSampleCount).toBe(meta.sampleCount);
  });
});
