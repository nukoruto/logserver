import { loadScenario } from '../../src/sim/scenario';
import { generateNormalSequence } from '../../src/sim/generator/normalGenerator';

describe('generateNormalSequence', () => {
  const scenario = loadScenario();

  it('生成された系列が正常フローと確率遷移を順守する', () => {
    const startTime = '2024-01-01T00:00:00.000Z';
    const sequence = generateNormalSequence({ scenario, seed: 'fsm-normal', startTime });

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
      expect(new Date(event.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(previousTimestamp).getTime());
      expect(event.deltaSeconds).toBeGreaterThanOrEqual(0);
      expect(event.probability).toBeGreaterThan(0);
      expect(event.probability).toBeLessThanOrEqual(1);
      expect(event.anomaly).toBe(false);
      previousTimestamp = event.timestamp;
    });

    const last = sequence[sequence.length - 1];
    expect(last.to).toBe('completed');
    expect(last.event).toBe('logout');
  });

  it('同一seedと開始時刻で系列が再現可能', () => {
    const startTime = '2024-01-01T00:00:00.000Z';
    const seqA = generateNormalSequence({ scenario, seed: 42, startTime });
    const seqB = generateNormalSequence({ scenario, seed: 42, startTime });
    expect(seqA).toEqual(seqB);
  });

  it('Δtの正規分布指定を尊重して生成する', () => {
    const gaussianScenario = {
      id: 'gaussian-flow',
      states: ['start', 'loop', 'end'],
      transitions: [
        {
          from: 'start',
          to: 'loop',
          event: 'login',
          probability: 1.0,
          deltaSeconds: { distribution: 'normal', mean: 2.0, stdDev: 0.4, min: 1.0, max: 3.0 },
        },
        {
          from: 'loop',
          to: 'loop',
          event: 'browse',
          probability: 0.6,
          deltaSeconds: { distribution: 'normal', mean: 2.0, stdDev: 0.4, min: 1.0, max: 3.0 },
        },
        {
          from: 'loop',
          to: 'end',
          event: 'logout',
          probability: 0.4,
          deltaSeconds: { distribution: 'normal', mean: 2.0, stdDev: 0.4, min: 1.0, max: 3.0 },
        },
      ],
      initialState: 'start',
      terminalStates: ['end'],
      defaultDeltaSeconds: { distribution: 'normal', mean: 2.0, stdDev: 0.4, min: 1.0, max: 3.0 },
    };

    const startTime = '2024-01-01T09:00:00.000Z';
    const sequence = generateNormalSequence({
      scenario: gaussianScenario,
      seed: 'gaussian-seed',
      startTime,
      maxSteps: 32,
    });

    expect(sequence.length).toBeGreaterThan(0);
    const deltas: number[] = sequence.map((event: any) => Number(event.deltaSeconds));
    deltas.forEach((delta: number) => {
      expect(delta).toBeGreaterThanOrEqual(1.0);
      expect(delta).toBeLessThanOrEqual(3.0);
    });
    const uniqueValues = new Set<string>(deltas.map((value: number) => value.toFixed(3)));
    expect(uniqueValues.size).toBeGreaterThan(1);

    const average = deltas.reduce((sum: number, value: number) => sum + value, 0) / deltas.length;
    expect(average).toBeGreaterThan(1.4);
    expect(average).toBeLessThan(2.6);
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
          deltaSeconds: { min: 0.1, max: 0.2 },
        },
      ],
      initialState: 'start',
      terminalStates: [],
      defaultDeltaSeconds: { min: 0.1, max: 0.2 },
    };

    const sequence = generateNormalSequence({ scenario: loopScenario, seed: 1, maxSteps: 3, startTime: '2024-01-01T00:00:00.000Z' });
    expect(sequence).toHaveLength(3);
  });
});
