type TestRequest = Record<string, unknown>;
type TestResponse = {
  locals: Record<string, unknown>;
  statusCode: number;
  once: (event: string, handler: () => void) => TestResponse;
  __events: Record<string, () => void>;
};
type TestNextFunction = () => void;

describe('csvSinkMiddleware pipeline', () => {
  const setup = async () => {
    jest.resetModules();

    const writeMock = jest.fn().mockResolvedValue(undefined);
    const shutdownMock = jest.fn().mockResolvedValue(undefined);
    const getMetricsMock = jest.fn().mockReturnValue({ totalWritten: 0, queueDepth: 0 });
    const getHealthStatusMock = jest.fn().mockReturnValue({
      healthy: true,
      state: 'ok',
      shuttingDown: false,
      lastError: null,
      lastSuccessAt: null,
      pendingWrites: 0,
      totalWritten: 0,
    });
    const loggerMock = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };

    jest.doMock('../src/config', () => ({
      __esModule: true,
      default: {
        csvRoot: '/tmp',
        csvRotation: 'daily',
        env: 'test',
      },
    }));

    jest.doMock('../src/sink/csvSink', () => {
      const FakeCsvSink = jest.fn().mockImplementation(() => ({
        write: writeMock,
        shutdown: shutdownMock,
        getMetrics: getMetricsMock,
        getHealthStatus: getHealthStatusMock,
      }));
      return {
        __esModule: true,
        default: FakeCsvSink,
        CsvSink: FakeCsvSink,
      };
    });

    jest.doMock('../src/utils/logger', () => ({
      __esModule: true,
      ...loggerMock,
      default: loggerMock,
    }));

    const module = await import('../src/index');

    return {
      module,
      writeMock,
      shutdownMock,
      getMetricsMock,
      getHealthStatusMock,
      loggerMock,
    };
  };

  const invokeMiddleware = (
    middleware: (req: TestRequest, res: TestResponse, next: TestNextFunction) => void,
    res: TestResponse,
    next: TestNextFunction
  ) => {
    middleware({} as TestRequest, res, next);
    const finish = res.__events.finish;
    if (finish) {
      finish();
    }
  };

  const createResponse = (logframe: Record<string, unknown>, statusCode = 200): TestResponse => {
    const events: Record<string, () => void> = {};
    const res: TestResponse = {
      locals: { __logframe: logframe },
      statusCode,
      __events: events,
      once: (event: string, handler: () => void) => {
        events[event] = handler;
        return res;
      },
    };
    return res;
  };

  it('sanitizes the logframe and warns when opCategory is missing', async () => {
    const { module, writeMock, loggerMock } = await setup();
    const { csvSinkMiddleware } = module;

    const hrtimeSpy = jest.spyOn(process.hrtime, 'bigint');
    hrtimeSpy.mockImplementationOnce(() => BigInt(1_000));
    hrtimeSpy.mockImplementationOnce(() => BigInt(2_100_000));

    const response = createResponse({
      timestamp_utc: '2024-05-01T12:00:00.000Z',
      method: 'post',
      path: '/login ',
      referer: ' https://example.com ',
      user_agent: ' UA ',
      uid: ' user ',
      session_id: ' sess ',
      ip: ' 127.0.0.1 ',
      op_category: 'read',
    }, 202);

    expect(response.__events.finish).toBeUndefined();
    invokeMiddleware(csvSinkMiddleware, response, jest.fn());
    expect(response.__events.finish).toBeDefined();

    expect(writeMock).toHaveBeenCalledTimes(1);
    const record = writeMock.mock.calls[0][0];
    expect(record.method).toBe('POST');
    expect(record.path).toBe('/login');
    expect(record.referer).toBe('https://example.com');
    expect(record.user_agent).toBe('UA');
    expect(record.uid).toBe('user');
    expect(record.session_id).toBe('sess');
    expect(record.ip).toBe('127.0.0.1');
    expect(record.op_category).toBe('READ');
    expect(record.status_code).toBe(202);
    expect(record.latency_ms).toBeCloseTo(2.099, 3);

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Operation category middleware missing for route',
      expect.objectContaining({ method: 'POST', path: '/login' })
    );

    hrtimeSpy.mockRestore();
  });

  it('does not warn when opCategory middleware has been applied', async () => {
    const { module, writeMock, loggerMock } = await setup();
    const { csvSinkMiddleware } = module;

    const hrtimeSpy = jest.spyOn(process.hrtime, 'bigint');
    hrtimeSpy.mockImplementationOnce(() => BigInt(5_000));
    hrtimeSpy.mockImplementationOnce(() => BigInt(6_500_000));

    const response = createResponse({
      timestamp_utc: '2024-05-01T12:00:00.000Z',
      method: 'get',
      path: '/secure ',
      referer: '',
      user_agent: 'Agent',
      uid: 'uid-1',
      session_id: 'sess-1',
      ip: '10.0.0.1',
      op_category: 'AUTH',
      __opCategorySet__: true,
    }, 200);

    expect(response.__events.finish).toBeUndefined();
    invokeMiddleware(csvSinkMiddleware, response, jest.fn());
    expect(response.__events.finish).toBeDefined();

    expect(writeMock).toHaveBeenCalledTimes(1);
    const record = writeMock.mock.calls[0][0];
    expect(record.op_category).toBe('AUTH');
    expect(loggerMock.warn).not.toHaveBeenCalled();

    hrtimeSpy.mockRestore();
  });
});
