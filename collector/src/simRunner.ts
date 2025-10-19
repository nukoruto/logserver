import { promises as fs } from 'node:fs';
import path from 'node:path';

import { generateScenario, type GenerateScenarioOptions, type SimulationResult } from './services/simulationService';
import {
  assertHealthy,
  coerceNumber,
  coerceTimestamp,
  HealthError,
  readNtpState,
  type NtpMeasurement,
} from './healthGate';

export interface SimulationRunnerOptions extends GenerateScenarioOptions {
  ntpStatePath?: string | null;
  ntpP95MsOverride?: number | string | null;
  ntpLastMeasuredAtOverride?: number | string | Date | null;
  freshnessMs?: number | string | null;
  healthNow?: number | string | Date | null;
  healthOutputPath?: string | null;
}

interface HealthReportPayload {
  status: 'unhealthy';
  reason: HealthError['code'];
  ntp_p95_ms: number;
  lastMeasuredAt: string;
}

const DEFAULT_HEALTH_OUTPUT = path.resolve(__dirname, '..', '..', 'out', 'health.json');

const ensureDirectory = async (targetPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
};

const writeHealthReport = async (targetPath: string, payload: HealthReportPayload): Promise<void> => {
  await ensureDirectory(targetPath);
  await fs.writeFile(targetPath, `${JSON.stringify(payload)}\n`, 'utf8');
};

const coerceFreshness = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined) {
    return fallback;
  }
  const numeric = coerceNumber(value, 'freshnessMs');
  if (numeric < 0) {
    throw new HealthError('METRICS_INCONSISTENT', 'freshnessMs must be non-negative');
  }
  return numeric;
};

const coerceNow = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined) {
    return fallback;
  }
  return coerceTimestamp(value, 'healthNow');
};

const resolveNtpMeasurement = async (options: SimulationRunnerOptions): Promise<NtpMeasurement> => {
  if (options.ntpP95MsOverride !== undefined || options.ntpLastMeasuredAtOverride !== undefined) {
    if (options.ntpP95MsOverride === undefined || options.ntpLastMeasuredAtOverride === undefined) {
      throw new HealthError(
        'METRICS_INCONSISTENT',
        'Both ntpP95MsOverride and ntpLastMeasuredAtOverride are required when overriding NTP state',
      );
    }
    const ntpP95Ms = coerceNumber(options.ntpP95MsOverride, 'ntpP95MsOverride');
    const lastMeasuredAt = coerceTimestamp(options.ntpLastMeasuredAtOverride, 'ntpLastMeasuredAtOverride');
    return { ntpP95Ms, lastMeasuredAt };
  }

  const statePath = options.ntpStatePath ?? process.env.NTP_STATE_PATH ?? null;
  return readNtpState(statePath);
};

export const runSimulation = async (
  options: SimulationRunnerOptions = {},
): Promise<SimulationResult> => {
  const freshnessMs = coerceFreshness(options.freshnessMs, 120_000);
  const now = coerceNow(options.healthNow, Date.now());
  const healthOutputPath = options.healthOutputPath
    ? path.resolve(options.healthOutputPath)
    : DEFAULT_HEALTH_OUTPUT;

  let measurement: NtpMeasurement | null = null;
  try {
    measurement = await resolveNtpMeasurement(options);
    assertHealthy(measurement.ntpP95Ms, measurement.lastMeasuredAt, now, freshnessMs);
  } catch (error) {
    if (error instanceof HealthError) {
      const ntpValue = (() => {
        if (measurement) {
          return measurement.ntpP95Ms;
        }
        if (options.ntpP95MsOverride !== undefined && options.ntpP95MsOverride !== null) {
          try {
            return coerceNumber(options.ntpP95MsOverride, 'ntpP95MsOverride');
          } catch {
            return 0;
          }
        }
        return 0;
      })();
      const lastMeasuredIso = (() => {
        if (measurement) {
          return new Date(measurement.lastMeasuredAt).toISOString();
        }
        if (options.ntpLastMeasuredAtOverride !== undefined && options.ntpLastMeasuredAtOverride !== null) {
          try {
            const epoch = coerceTimestamp(options.ntpLastMeasuredAtOverride, 'ntpLastMeasuredAtOverride');
            return new Date(epoch).toISOString();
          } catch {
            return new Date(now).toISOString();
          }
        }
        return new Date(now).toISOString();
      })();

      const payload: HealthReportPayload = {
        status: 'unhealthy',
        reason: error.code,
        ntp_p95_ms: ntpValue,
        lastMeasuredAt: lastMeasuredIso,
      };
      await writeHealthReport(healthOutputPath, payload);
      throw error;
    }
    throw error;
  }

  const {
    ntpP95MsOverride,
    ntpLastMeasuredAtOverride,
    ntpStatePath,
    freshnessMs: _freshness,
    healthNow,
    healthOutputPath: _healthOutput,
    ...scenarioOptions
  } = options;

  try {
    const result = await generateScenario({
      ...scenarioOptions,
      ntpP95Ms: measurement.ntpP95Ms,
      ntpLastMeasuredAt: measurement.lastMeasuredAt,
      ntpFreshnessMs: freshnessMs,
      healthNow: now,
      healthValidated: true,
    });
    return result;
  } catch (error) {
    if (error instanceof HealthError) {
      const payload: HealthReportPayload = {
        status: 'unhealthy',
        reason: error.code,
        ntp_p95_ms: measurement.ntpP95Ms,
        lastMeasuredAt: new Date(measurement.lastMeasuredAt).toISOString(),
      };
      await writeHealthReport(healthOutputPath, payload);
    }
    throw error;
  }
};

export default { runSimulation };
