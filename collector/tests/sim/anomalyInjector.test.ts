import { injectAnomaly } from '../../src/sim/generator/anomalyInjector';

const createBaseSequence = () => [
  {
    event: 'login',
    from: 'start',
    to: 'authenticated',
    timestamp: '2024-01-01T00:00:00.000Z',
    deltaSeconds: 0,
    probability: 1,
    anomaly: false,
    session_id: 'sess-1',
    user_id: 'user-1',
    metadata: {},
  },
  {
    event: 'browse',
    from: 'authenticated',
    to: 'browsing',
    timestamp: '2024-01-01T00:00:02.000Z',
    deltaSeconds: 2,
    probability: 0.8,
    anomaly: false,
    session_id: 'sess-1',
    user_id: 'user-1',
    metadata: {},
  },
  {
    event: 'edit',
    from: 'browsing',
    to: 'editing',
    timestamp: '2024-01-01T00:00:05.000Z',
    deltaSeconds: 3,
    probability: 0.6,
    anomaly: false,
    session_id: 'sess-1',
    user_id: 'user-1',
    metadata: {},
  },
  {
    event: 'logout',
    from: 'editing',
    to: 'completed',
    timestamp: '2024-01-01T00:00:09.000Z',
    deltaSeconds: 4,
    probability: 1,
    anomaly: false,
    session_id: 'sess-1',
    user_id: 'user-1',
    metadata: {},
  },
];

describe('injectAnomaly', () => {
  it('プロトコル順序違反としてログイン前操作を挿入する', () => {
    const base = createBaseSequence();
    const mutated = injectAnomaly(base, {
      anomalyCount: 1,
      seed: 'protocol-test',
      strategies: {
        protocolViolation: {
          weight: 1,
          logoutLoginLoopProbability: 0,
          preLoginEvents: ['edit'],
          insertOffsetSeconds: -10,
        },
        timeDeviation: { weight: 0 },
        authenticationBypass: { weight: 0 },
      },
    });

    expect(mutated).not.toBe(base);
    expect(mutated.length).toBe(base.length + 1);

    const firstEvent = mutated[0];
    expect(firstEvent.event).toBe('edit');
    expect(firstEvent.anomaly).toBe(true);
    expect(firstEvent._anomalyType).toBe('protocolViolation');
    expect(firstEvent._anomalyDetails?.reason).toBe('preLoginOperation');

    const loginEvents = mutated.filter((event: any) => event.event === 'login');
    expect(loginEvents.length).toBe(1);
    expect(new Date(firstEvent.timestamp ?? '').getTime()).toBeLessThan(
      new Date(loginEvents[0].timestamp ?? '').getTime()
    );
  });

  it('時間逸脱を注入しΔtが大きく変化する', () => {
    const base = createBaseSequence();
    const mutated = injectAnomaly(base, {
      anomalyCount: 1,
      seed: 'time-test',
      strategies: {
        protocolViolation: { weight: 0 },
        timeDeviation: { weight: 1, longProbability: 1, longGapSeconds: 480 },
        authenticationBypass: { weight: 0 },
      },
    });

    const deviations = mutated.filter((event: any) => event._anomalyType === 'timeDeviation');
    expect(deviations.length).toBeGreaterThanOrEqual(1);
    const target = deviations[0];
    const index = mutated.indexOf(target);
    expect(index).toBeGreaterThan(0);

    const previous = mutated[index - 1];
    const deltaMillis = new Date(target.timestamp ?? '').getTime() - new Date(previous.timestamp ?? '').getTime();
    expect(Math.round(target.deltaSeconds ?? 0)).toBe(480);
    expect(Math.round(deltaMillis / 1000)).toBe(480);
    expect(target.deltaOffsetSeconds).toBeGreaterThanOrEqual(470);
  });

  it('認証不備を注入しセッションIDとユーザIDを不正化する', () => {
    const base = createBaseSequence();
    const mutated = injectAnomaly(base, {
      anomalyRate: 1,
      anomalyCount: 1,
      seed: 'auth-test',
      strategies: {
        protocolViolation: { weight: 0 },
        timeDeviation: { weight: 0 },
        authenticationBypass: { weight: 1, unauthorizedEvents: ['edit'] },
      },
    });

    const unauthorizedEvents = mutated.filter((event: any) => event._anomalyType === 'authenticationBypass');
    expect(unauthorizedEvents.length).toBe(1);
    const target = unauthorizedEvents[0];
    expect(target.session_id).toMatch(/^invalid-session-/);
    expect(target.user_id).toMatch(/^spoofed-user-/);
    expect(target.authenticated).toBe(false);
    expect(target.metadata?.auth?.status).toBe('invalid');
    expect(target.metadata?.auth?.reason).toBe('unauthorizedOperation');
  });
});
