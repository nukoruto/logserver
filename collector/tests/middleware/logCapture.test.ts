describe('logCapture middleware', () => {
  const originalJwtKey = process.env.JWT_HMAC_KEY;

  beforeEach(() => {
    jest.resetModules();
    if (originalJwtKey === undefined) {
      delete process.env.JWT_HMAC_KEY;
    } else {
      process.env.JWT_HMAC_KEY = originalJwtKey;
    }
    delete process.env.JWT_HMAC_KEY;
  });

  afterAll(() => {
    if (originalJwtKey === undefined) {
      delete process.env.JWT_HMAC_KEY;
    } else {
      process.env.JWT_HMAC_KEY = originalJwtKey;
    }
  });

  it('populates logframe and strips sensitive headers', async () => {
    const key = 'a'.repeat(64);
    process.env.JWT_HMAC_KEY = key;

    const { jwtToUid } = await import('../../src/security/uid');
    const expectedUid = jwtToUid('token-123', key);
    const { default: logCapture } = await import('../../src/middleware/logCapture');

    const req: any = {
      method: 'POST',
      originalUrl: '/api/v1/events',
      headers: {
        authorization: 'Bearer token-123',
        cookie: 'session_id=abc123; theme=dark',
        'x-forwarded-for': '203.0.113.1, 70.0.0.1',
        referer: 'https://example.com/path',
        'user-agent': 'agent/1.0',
      },
      ips: ['203.0.113.2'],
      ip: '198.51.100.10',
      socket: { remoteAddress: '192.0.2.10' },
      connection: { remoteAddress: '192.0.2.20' },
    };
    const res: any = { locals: {} };
    const next = jest.fn();

    logCapture(req, res, next);

    expect(res.locals.__logframe).toBeDefined();
    expect(res.locals.__logframe).toMatchObject({
      method: 'POST',
      path: '/api/v1/events',
      referer: 'https://example.com/path',
      user_agent: 'agent/1.0',
      ip: '203.0.113.1',
      session_id: 'abc123',
      uid: expectedUid,
      op_category: 'READ',
    });
    expect(typeof res.locals.__logframe.timestamp_utc).toBe('string');
    expect(res.locals.__logframe.timestamp_utc.endsWith('Z')).toBe(true);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles missing sensitive data gracefully', async () => {
    const { default: logCapture } = await import('../../src/middleware/logCapture');

    const req: any = {
      method: 'GET',
      url: '/api/v1/health',
      headers: {},
      socket: {},
      connection: {},
    };
    const res: any = { locals: {} };
    const next = jest.fn();

    logCapture(req, res, next);

    expect(res.locals.__logframe).toMatchObject({
      method: 'GET',
      path: '/api/v1/health',
      referer: '',
      user_agent: '',
      ip: '',
      session_id: '',
      uid: '',
      op_category: 'READ',
    });
    expect(res.locals.__logframe.timestamp_utc.endsWith('Z')).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported HTTP methods with validation error', async () => {
    const { default: logCapture } = await import('../../src/middleware/logCapture');

    const req: any = {
      method: 'PATCH',
      url: '/any',
      headers: {},
      socket: {},
      connection: {},
    };
    const res: any = { locals: {} };
    const next = jest.fn();

    logCapture(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(500);
    expect(error.issues).toBeDefined();
  });
});
