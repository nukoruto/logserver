const { labelSequence } = require('../../src/sim/labeler');

describe('labelSequence', () => {
  it('正常イベントに normal ラベルを付与し metadata.anomaly を設定する', () => {
    const events = [
      {
        timestamp: '2024-03-01T00:00:00.000Z',
        session_id: 'sess-1',
        user_id: 'user-1',
        event: 'login',
        metadata: { op_category: 'AUTH' },
      },
    ];

    const labeled = labelSequence(events);
    expect(labeled).toHaveLength(1);
    const [first] = labeled;
    expect(first.anomaly_type).toBe('normal');
    expect(first.anomalyLabel).toBe(0);
    expect(first.metadata).toMatchObject({ op_category: 'AUTH', anomaly: 'normal' });
  });

  it('プロトコル違反イベントに protocol_violation を付与する', () => {
    const events = [
      {
        timestamp: '2024-03-01T00:00:00.000Z',
        session_id: 'sess-1',
        user_id: 'user-1',
        event: 'login',
      },
      {
        timestamp: '2024-03-01T00:00:05.000Z',
        session_id: 'sess-1',
        user_id: 'user-1',
        event: 'delete',
        protocolViolationFlag: true,
        protocolViolationReasons: ['disallowedTransition'],
      },
    ];

    const labeled = labelSequence(events);
    expect(labeled[1].anomaly_type).toBe('protocol_violation');
    expect(labeled[1].anomalyLabel).toBe(1);
    expect(labeled[1].metadata.anomaly).toBe('protocol_violation');
  });

  it('認証不備が検出されたイベントを auth_failure とする', () => {
    const events = [
      {
        timestamp: '2024-03-01T00:00:01.000Z',
        session_id: 'sess-1',
        user_id: 'user-1',
        event: 'edit',
        protocolViolationFlag: true,
        protocolViolationReasons: ['unauthenticatedOperation'],
      },
    ];

    const labeled = labelSequence(events);
    expect(labeled[0].anomaly_type).toBe('auth_failure');
    expect(labeled[0].anomalyLabel).toBe(1);
    expect(labeled[0].metadata.anomaly).toBe('auth_failure');
  });

  it('時間逸脱イベントを time_deviation としてラベル付けする', () => {
    const events = [
      {
        timestamp: '2024-03-01T00:00:00.000Z',
        session_id: 'sess-1',
        user_id: 'user-1',
        event: 'browse',
        timeDeviationFlag: true,
      },
    ];

    const labeled = labelSequence(events);
    expect(labeled[0].anomaly_type).toBe('time_deviation');
    expect(labeled[0].anomalyLabel).toBe(1);
    expect(labeled[0].metadata.anomaly).toBe('time_deviation');
  });

  it('異常注入時のマークから auth_failure を推定する', () => {
    const events = [
      {
        timestamp: '2024-03-01T00:00:02.000Z',
        session_id: 'sess-2',
        user_id: 'user-9',
        event: 'edit',
        anomaly: true,
        _anomalyType: 'authenticationBypass',
        metadata: { foo: 'bar' },
      },
    ];

    const labeled = labelSequence(events);
    expect(labeled[0].anomaly_type).toBe('auth_failure');
    expect(labeled[0].anomalyLabel).toBe(1);
    expect(labeled[0].metadata).toMatchObject({ foo: 'bar', anomaly: 'auth_failure' });
  });
});
