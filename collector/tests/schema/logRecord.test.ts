import {
  HTTP_METHODS,
  LogRecordValidationError,
  OPERATION_CATEGORIES,
  type HttpMethod,
  type OperationCategory,
  validateLogRecord,
} from '../../src/schema/logRecord';

describe('logRecord schema', () => {
  it('accepts valid records and normalises blankable fields', () => {
    const record = validateLogRecord({
      timestamp_utc: '2024-08-01T12:34:56.789Z',
      method: 'GET',
      path: '   /path  ',
      referer: undefined,
      user_agent: null,
      uid: '  user  ',
      session_id: '  session ',
      ip: ' 203.0.113.10 ',
      op_category: 'READ',
      status_code: 200,
      latency_ms: 12.5,
    });

    expect(record.path).toBe('/path');
    expect(record.referer).toBe('');
    expect(record.user_agent).toBe('');
    expect(record.uid).toBe('user');
    expect(record.session_id).toBe('session');
    expect(record.ip).toBe('203.0.113.10');
  });

  it('rejects timestamps that are not RFC 3339', () => {
    expect(() =>
      validateLogRecord({
        timestamp_utc: '2024/08/01 12:34:56',
        method: 'GET',
        op_category: 'READ',
      })
    ).toThrow(LogRecordValidationError);
  });

  it('rejects unsupported HTTP methods', () => {
    expect(() =>
      validateLogRecord({
        timestamp_utc: '2024-08-01T12:34:56.789Z',
        method: 'TRACE' as HttpMethod,
        op_category: 'READ',
      })
    ).toThrow(LogRecordValidationError);
  });

  it('rejects operation categories outside the contract', () => {
    expect(() =>
      validateLogRecord({
        timestamp_utc: '2024-08-01T12:34:56.789Z',
        method: 'GET',
        op_category: 'DELETE' as OperationCategory,
      })
    ).toThrow(LogRecordValidationError);
  });
});
