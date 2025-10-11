describe('opCategory middleware', () => {
  it('sets op_category on existing logframe', async () => {
    const { default: opCategory } = await import('../../src/middleware/opCategory');

    const middleware = opCategory('AUTH');
    const req: any = {};
    const res: any = {
      locals: {
        __logframe: {
          method: 'POST',
          op_category: 'READ',
        },
      },
    };
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.locals.__logframe.op_category).toBe('AUTH');
    expect(res.locals.__logframe.method).toBe('POST');
    expect(res.locals.__logframe.__opCategorySet__).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('initialises logframe when missing', async () => {
    const { default: opCategory } = await import('../../src/middleware/opCategory');

    const middleware = opCategory('UPDATE');
    const req: any = {};
    const res: any = { locals: {} };
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.locals.__logframe).toBeDefined();
    expect(res.locals.__logframe.op_category).toBe('UPDATE');
    expect(res.locals.__logframe.__opCategorySet__).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
