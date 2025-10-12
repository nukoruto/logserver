import { Router } from 'express';
import type { Request, Response } from 'express';
import sanitize from '../middleware/sanitize';
import logCapture from '../middleware/logCapture';
import opCategory from '../middleware/opCategory';
import auth from '../middleware/auth';
import asyncHandler from '../utils/asyncHandler';
import { generateScenario, normalizeAnomalyList } from '../services/simulationService';

const router = Router();

router.use(sanitize);
router.use(logCapture);
router.use(auth);
router.use(opCategory('UPDATE'));

const normalizePersistFlag = (value: unknown): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
};

const normalizeStartTime = (value: unknown): Date | string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
};

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const anomaliesInput = Array.isArray(body.anomalies)
      ? body.anomalies
      : typeof body.anomalies === 'string'
        ? body.anomalies.split(',')
        : [];
    const anomalies = Array.from(normalizeAnomalyList(anomaliesInput));

    const persistOverride = normalizePersistFlag(body.persist);

    const result = await generateScenario({
      count: body.count as number | undefined,
      anomalies,
      seed: body.seed as string | number | null | undefined,
      scenarioPath: (body.scenarioPath ?? body.scenarioFile ?? body.scenario) as string | undefined,
      anomalyRate: body.anomalyRate as number | undefined,
      anomalyCount: body.anomalyCount as number | null | undefined,
      outputDir: body.outputDir as string | undefined,
      csvFileName: (body.csvFileName ?? body.csvFile) as string | undefined,
      manifestFileName: (body.manifestFileName ?? body.manifestFile) as string | undefined,
      runId: body.runId as string | null | undefined,
      persist: persistOverride !== undefined ? persistOverride : undefined,
      startTime: normalizeStartTime(body.startTime),
      sessionSpacingSeconds: (body.sessionSpacingSeconds ?? body.sessionSpacing) as number | undefined,
      maxSteps: body.maxSteps as number | undefined,
    });

    res.status(201).json({ data: result });
  })
);

export { router };
export default router;
