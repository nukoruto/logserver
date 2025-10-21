export interface NhppSineConfig {
  lambda0: number;
  amplitude: number;
  phaseHour: number;
  horizonSeconds: number;
  epsilon: number;
}

const TWO_PI = 2 * Math.PI;
const HOURS_PER_DAY = 24;
const MIN_RATE = 1e-6;

const clampAmplitude = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const limited = Math.max(-0.95, Math.min(0.95, value));
  return limited;
};

const normalizeConfig = (config: NhppSineConfig): NhppSineConfig => ({
  lambda0: Math.max(MIN_RATE, config.lambda0),
  amplitude: clampAmplitude(config.amplitude),
  phaseHour: Number.isFinite(config.phaseHour) ? config.phaseHour : 0,
  horizonSeconds: config.horizonSeconds > 0 ? config.horizonSeconds : 86_400,
  epsilon: config.epsilon > 0 ? config.epsilon : 1e-3,
});

const intensity = (tSeconds: number, config: NhppSineConfig): number => {
  const hours = (tSeconds / 3600) - config.phaseHour;
  const sine = Math.sin((TWO_PI * hours) / HOURS_PER_DAY);
  const rate = config.lambda0 * (1 + config.amplitude * sine);
  return Math.max(MIN_RATE, rate);
};

export const sampleNhppDelta = (
  randomFn: () => number,
  rawConfig: NhppSineConfig,
  currentSeconds: number,
): number => {
  const config = normalizeConfig(rawConfig);
  const lambdaMax = config.lambda0 * (1 + Math.abs(config.amplitude));
  const safeLambdaMax = Math.max(lambdaMax, MIN_RATE * 10);
  let t = currentSeconds;
  for (let iterations = 0; iterations < 100_000; iterations += 1) {
    const u = Math.max(Number.EPSILON, 1 - randomFn());
    const wait = -Math.log(u) / safeLambdaMax;
    t += wait;
    if (t - currentSeconds > config.horizonSeconds) {
      return Math.max(config.epsilon, config.horizonSeconds);
    }
    const lambdaT = intensity(t, config);
    const acceptance = Math.min(1, lambdaT / safeLambdaMax);
    if (randomFn() <= acceptance) {
      const delta = t - currentSeconds;
      return Math.max(config.epsilon, delta);
    }
  }
  return config.epsilon;
};

export const resolveNhppConfig = (
  record: Record<string, unknown>,
  epsilon: number,
): NhppSineConfig | null => {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const baseLambda = Number(record.lambda0 ?? record.lambda ?? record.base ?? 0.5);
  const amplitude = Number(record.amplitude ?? record.a ?? 0.5);
  const phase = Number(record.phaseHour ?? record.phase ?? record.phi ?? 0);
  const horizon = Number(record.horizonSeconds ?? record.horizon ?? 86_400);
  if (!Number.isFinite(baseLambda) || baseLambda <= 0) {
    return null;
  }
  return normalizeConfig({
    lambda0: baseLambda,
    amplitude,
    phaseHour: Number.isFinite(phase) ? phase : 0,
    horizonSeconds: Number.isFinite(horizon) && horizon > 0 ? horizon : 86_400,
    epsilon,
  });
};
