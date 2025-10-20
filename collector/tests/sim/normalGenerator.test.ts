import { loadScenario } from '../../src/sim/scenario';
import { generateNormalSequence, DEFAULT_DELTA_EPSILON } from '../../src/sim/generator/normalGenerator';

const padNumber = (value: number, length = 2): string => value.toString().padStart(length, '0');

const formatLocalFromUtc = (utcMillis: number, offsetSeconds: number): string => {
  const localMillis = utcMillis + offsetSeconds * 1000;
  const date = new Date(localMillis);
  const year = date.getUTCFullYear();
  const month = padNumber(date.getUTCMonth() + 1);
  const day = padNumber(date.getUTCDate());
  const hours = padNumber(date.getUTCHours());
  const minutes = padNumber(date.getUTCMinutes());
  const seconds = padNumber(date.getUTCSeconds());
  const milliseconds = padNumber(date.getUTCMilliseconds(), 3);
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetSeconds);
  const offsetHours = padNumber(Math.floor(absolute / 3600));
  const offsetMinutes = padNumber(Math.floor((absolute % 3600) / 60));
  const suffix = offsetSeconds === 0 ? 'Z' : `${sign}${offsetHours}:${offsetMinutes}`;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${suffix}`;
};

const MAD_TO_STD = 1.4826;

const computeMedian = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const computeMad = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const median = computeMedian(values);
  const deviations = values.map((value) => Math.abs(value - median));
  return computeMedian(deviations);
};

describe('generateNormalSequence', () => {
  const scenario = loadScenario();

  it('生成された系列が正常フローと確率遷移を順守する', () => {
    const startTime = '2024-01-01T00:00:00.000Z';
    const sequence = generateNormalSequence({
      scenario,
      seed: 'fsm-normal',
      startTime,
      sessionId: 'sess-fsm',
      uid: 'uid-fsm',
    });

    expect(sequence.length).toBeGreaterThan(0);

    const first = sequence[0];
    expect(first.from).toBe('start');
    expect(first.to).toBe('authenticated');
    expect(first.event).toBe('login');
    expect(first.anomaly).toBe(false);

    const transitions = new Set<string>(
      (scenario.transitions as Array<{ from: string; to: string }>).map((item) => `${item.from}->${item.to}`)
    );
    let previousTimestamp = startTime;

    sequence.forEach((event: any) => {
      expect(transitions.has(`${event.from}->${event.to}`)).toBe(true);
      expect(typeof event.timestamp).toBe('string');
      expect(typeof event.timestamp_utc).toBe('string');
      expect(new Date(event.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(previousTimestamp).getTime());
      expect(new Date(event.timestamp_utc).getTime()).toBeGreaterThanOrEqual(new Date(previousTimestamp).getTime());
      expect(event.deltaSeconds).toBeGreaterThanOrEqual(DEFAULT_DELTA_EPSILON);
      expect(event.probability).toBeGreaterThan(0);
      expect(event.probability).toBeLessThanOrEqual(1);
      expect(event.anomaly).toBe(false);
      previousTimestamp = event.timestamp;
    });

    const last = sequence[sequence.length - 1];
    expect(last.to).toBe('completed');
    expect(last.event).toBe('logout');
  });

  it('ローカル時刻とUTCがオフセット込みで保持される', () => {
    const startTime = '2024-01-01T09:00:00+09:00';
    const sequence = generateNormalSequence({
      scenario,
      seed: 'offset-check',
      startTime,
      maxSteps: 2,
      sessionId: 'sess-offset',
      uid: 'uid-offset',
    });
    expect(sequence.length).toBeGreaterThan(0);
    const first = sequence[0];
    expect(first.timestamp?.endsWith('+09:00')).toBe(true);
    expect(first.timestamp_utc?.endsWith('Z')).toBe(true);
    const offsetSeconds = Number(first.metadata?.timezone_offset_seconds);
    expect(offsetSeconds).toBe(9 * 3600);
    const reconstructed = formatLocalFromUtc(new Date(first.timestamp_utc as string).getTime(), offsetSeconds);
    expect(first.timestamp).toBe(reconstructed);
  });

  it('同一seedと開始時刻で系列が再現可能', () => {
    const startTime = '2024-01-01T00:00:00.000Z';
    const seqA = generateNormalSequence({
      scenario,
      seed: 42,
      startTime,
      sessionId: 'sess-deterministic',
      uid: 'uid-deterministic',
    });
    const seqB = generateNormalSequence({
      scenario,
      seed: 42,
      startTime,
      sessionId: 'sess-deterministic',
      uid: 'uid-deterministic',
    });
    expect(seqA).toEqual(seqB);
  });

  it('Δtの対数正規分布指定を尊重して生成する', () => {
    const sigmaLog = 0.4;
    const lognormalSpec = {
      distribution: 'lognormal' as const,
      medianLog: Math.log(2.0),
      sigmaLog,
      madLog: sigmaLog / MAD_TO_STD,
      epsilon: DEFAULT_DELTA_EPSILON,
    };

    const gaussianScenario = {
      id: 'gaussian-flow',
      states: ['start', 'loop', 'end'],
      transitions: [
        {
          from: 'start',
          to: 'loop',
          event: 'login',
          probability: 1.0,
          deltaSeconds: lognormalSpec,
        },
        {
          from: 'loop',
          to: 'loop',
          event: 'browse',
          probability: 0.6,
          deltaSeconds: lognormalSpec,
        },
        {
          from: 'loop',
          to: 'end',
          event: 'logout',
          probability: 0.4,
          deltaSeconds: lognormalSpec,
        },
      ],
      initialState: 'start',
      terminalStates: ['end'],
      defaultDeltaSeconds: lognormalSpec,
    };

    const startTime = '2024-01-01T09:00:00.000Z';
    const sequence = generateNormalSequence({
      scenario: gaussianScenario,
      seed: 'gaussian-seed',
      startTime,
      maxSteps: 32,
      sessionId: 'sess-gaussian',
      uid: 'uid-gaussian',
    });

    expect(sequence.length).toBeGreaterThan(0);
    const deltas: number[] = sequence.map((event: any) => Number(event.deltaSeconds));
    deltas.forEach((delta: number) => {
      expect(delta).toBeGreaterThanOrEqual(DEFAULT_DELTA_EPSILON);
    });
    const uniqueValues = new Set<string>(deltas.map((value: number) => value.toFixed(3)));
    expect(uniqueValues.size).toBeGreaterThan(1);

    const logValues = deltas.map((value: number) => Math.log(value));
    const medianLog = computeMedian(logValues);
    const madLog = computeMad(logValues);
    const estimatedSigma = madLog * MAD_TO_STD;
    const expectedMu = lognormalSpec.medianLog;
    const expectedSigma = lognormalSpec.sigmaLog;

    expect(medianLog).toBeGreaterThan(expectedMu - 0.35);
    expect(medianLog).toBeLessThan(expectedMu + 0.35);
    expect(estimatedSigma).toBeGreaterThan(expectedSigma - 0.35);
    expect(estimatedSigma).toBeLessThan(expectedSigma + 0.35);
  });

  it('deltaEpsilon オプションで Δt の最小値を制御できる', () => {
    const epsilonFloor = 0.02;
    const scenarioWithLowEpsilon = {
      id: 'epsilon-floor',
      states: ['start', 'end'],
      transitions: [
        {
          from: 'start',
          to: 'end',
          event: 'login',
          probability: 1,
          deltaSeconds: { distribution: 'lognormal', medianLog: -4, sigmaLog: 0.2, epsilon: 1e-5 },
        },
      ],
      initialState: 'start',
      terminalStates: ['end'],
      defaultDeltaSeconds: { distribution: 'lognormal', medianLog: -4, sigmaLog: 0.2, epsilon: 1e-5 },
    };

    const sequence = generateNormalSequence({
      scenario: scenarioWithLowEpsilon,
      seed: 'epsilon-floor',
      maxSteps: 8,
      deltaEpsilon: epsilonFloor,
    });

    const deltas = sequence.map((event: any) => Number(event.deltaSeconds));
    expect(Math.min(...deltas)).toBeGreaterThanOrEqual(epsilonFloor);
  });

  it('normal/uniform 分布指定には非推奨警告を出す', () => {
    const warnSpy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined as unknown as void);
    try {
      const scenarioDeprecated = {
        id: 'deprecated-distributions',
        states: ['start', 'mid', 'end'],
        transitions: [
          {
            from: 'start',
            to: 'mid',
            event: 'login',
            probability: 1,
            deltaSeconds: { distribution: 'normal', mean: 2, stdDev: 0.1 },
          },
          {
            from: 'mid',
            to: 'end',
            event: 'logout',
            probability: 1,
            deltaSeconds: { distribution: 'uniform', min: 1, max: 3 },
          },
        ],
        initialState: 'start',
        terminalStates: ['end'],
        defaultDeltaSeconds: { distribution: 'lognormal', medianLog: 0, sigmaLog: 0.3 },
      };

      generateNormalSequence({ scenario: scenarioDeprecated, seed: 'deprecated', maxSteps: 3 });

      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('normal'))).toBe(true);
      expect(messages.some((message) => message.includes('uniform'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('最大ステップ数でループを安全に終了する', () => {
    const loopScenario = {
      id: 'loop',
      states: ['start'],
      transitions: [
        {
          from: 'start',
          to: 'start',
          event: 'ping',
          probability: 1.0,
          deltaSeconds: {
            distribution: 'lognormal',
            medianLog: -1.9153038069713184,
            sigmaLog: 0.19070302611881856,
            madLog: 0.12862742892136692,
            epsilon: DEFAULT_DELTA_EPSILON,
          },
        },
      ],
      initialState: 'start',
      terminalStates: [],
      defaultDeltaSeconds: {
        distribution: 'lognormal',
        medianLog: -1.9153038069713184,
        sigmaLog: 0.19070302611881856,
        madLog: 0.12862742892136692,
        epsilon: DEFAULT_DELTA_EPSILON,
      },
    };

    const sequence = generateNormalSequence({
      scenario: loopScenario,
      seed: 1,
      maxSteps: 3,
      startTime: '2024-01-01T00:00:00.000Z',
      sessionId: 'sess-loop',
      uid: 'uid-loop',
    });
    expect(sequence).toHaveLength(3);
  });
});
