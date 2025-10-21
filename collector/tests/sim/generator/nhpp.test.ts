import { sampleNhppDelta, resolveNhppConfig } from '../../../src/sim/generator/nhpp';

describe('nhpp generator', () => {
  const makeRng = (values: number[]): (() => number) => {
    let index = 0;
    return () => {
      const value = values[index % values.length];
      index += 1;
      return value;
    };
  };

  it('accepts sine intensity and produces shorter deltas near peaks', () => {
    const baseConfig = resolveNhppConfig(
      {
        lambda0: 0.5,
        amplitude: 0.6,
        phaseHour: 6,
        horizonSeconds: 3600,
      },
      1e-3,
    );
    expect(baseConfig).not.toBeNull();
    const config = baseConfig!;
    const rngValues = [0.1, 0.3, 0.7, 0.2, 0.8];
    const morningRng = makeRng(rngValues);
    const eveningRng = makeRng(rngValues);
    const morningDelta = sampleNhppDelta(morningRng, config, 6 * 3600);
    const eveningDelta = sampleNhppDelta(eveningRng, config, 18 * 3600);
    expect(morningDelta).toBeGreaterThan(0);
    expect(eveningDelta).toBeGreaterThan(0);
    expect(morningDelta).toBeLessThan(eveningDelta);
  });
});
