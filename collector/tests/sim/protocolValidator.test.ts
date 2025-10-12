import { validateProtocol } from '../../src/sim/detector/protocolValidator';

const buildEvent = (overrides: Record<string, any> = {}) => {
  const source = overrides;
  return {
    timestamp: source.timestamp ?? '2024-03-01T00:00:00.000Z',
    session_id: source.session_id ?? 'sess-123456',
    user_id: source.user_id ?? 'user-1',
    uid: source.uid ?? 'uid-1',
    event: source.event ?? 'login',
    op_category: source.op_category ?? 'AUTH',
    ...source,
  };
};

describe('validateProtocol', () => {
  it('正常系列では違反フラグが立たない', () => {
    const sequence = [
      buildEvent({ event: 'login', op_category: 'AUTH' }),
      buildEvent({ event: 'browse', op_category: 'READ', timestamp: '2024-03-01T00:00:02.000Z' }),
      buildEvent({ event: 'edit', op_category: 'UPDATE', timestamp: '2024-03-01T00:00:04.000Z' }),
      buildEvent({ event: 'save', op_category: 'UPDATE', timestamp: '2024-03-01T00:00:06.000Z' }),
      buildEvent({ event: 'logout', op_category: 'AUTH', timestamp: '2024-03-01T00:00:08.000Z' }),
    ];

    const validated = validateProtocol(sequence);
    expect(validated).toHaveLength(sequence.length);
    validated.forEach((event: any) => {
      expect(event.protocolViolationFlag).toBe(false);
      expect(event.protocolViolationReasons).toEqual([]);
    });
  });

  it('未認証操作を検出する', () => {
    const sequence = [
      buildEvent({ event: 'edit', op_category: 'UPDATE' }),
      buildEvent({ event: 'login', op_category: 'AUTH', timestamp: '2024-03-01T00:00:02.000Z' }),
    ];

    const validated = validateProtocol(sequence);
    expect(validated[0].protocolViolationFlag).toBe(true);
    expect(validated[0].protocolViolationReasons).toEqual(
      expect.arrayContaining(['missingInitialLogin', 'unauthenticatedBeforeLogin'])
    );
    expect(validated[1].protocolViolationFlag).toBe(false);
  });

  it('重複ログインとログアウト後操作を検出する', () => {
    const sequence = [
      buildEvent({ event: 'login', op_category: 'AUTH' }),
      buildEvent({ event: 'login', op_category: 'AUTH', timestamp: '2024-03-01T00:00:02.000Z' }),
      buildEvent({ event: 'logout', op_category: 'AUTH', timestamp: '2024-03-01T00:00:04.000Z' }),
      buildEvent({ event: 'browse', op_category: 'READ', timestamp: '2024-03-01T00:00:06.000Z' }),
    ];

    const validated = validateProtocol(sequence);
    expect(validated[1].protocolViolationReasons).toContain('duplicateLogin');
    expect(validated[3].protocolViolationReasons).toContain('postLogoutOperation');
  });

  it('セッション内のユーザID変化と不正な遷移を検出する', () => {
    const sequence = [
      buildEvent({ event: 'login', op_category: 'AUTH' }),
      buildEvent({
        event: 'edit',
        op_category: 'UPDATE',
        timestamp: '2024-03-01T00:00:02.000Z',
        user_id: 'user-2',
      }),
    ];

    const validated = validateProtocol(sequence, {
      allowedTransitions: [
        { from: 'login', to: 'browse' },
      ],
    });

    expect(validated[1].protocolViolationReasons).toEqual(
      expect.arrayContaining(['userIdMismatch', 'disallowedTransition'])
    );
  });

  it('セッションID形式の異常とトークン使い回しを検出する', () => {
    const sequence = [
      buildEvent({ session_id: 'bad', uid: 'uid-1', event: 'login' }),
      buildEvent({
        event: 'browse',
        op_category: 'READ',
        timestamp: '2024-03-01T00:00:02.000Z',
        uid: 'uid-2',
        session_id: 'bad',
      }),
    ];

    const validated = validateProtocol(sequence);
    expect(validated[0].protocolViolationReasons).toContain('invalidSessionIdFormat');
    expect(validated[1].protocolViolationReasons).toContain('tokenMismatch');
  });
});
