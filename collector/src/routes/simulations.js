const express = require('express');
const sanitize = require('../middleware/sanitize');
const logCapture = require('../middleware/logCapture');
const opCategory = require('../middleware/opCategory');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { generateScenario, normalizeAnomalyList } = require('../services/simulationService');

const router = express.Router();

router.use(sanitize);
router.use(logCapture);
router.use(auth);
router.use(opCategory('UPDATE'));

const normalizePersistFlag = (value) => {
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

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const anomaliesInput = Array.isArray(body.anomalies)
      ? body.anomalies
      : typeof body.anomalies === 'string'
        ? body.anomalies.split(',')
        : [];
    const anomalies = Array.from(normalizeAnomalyList(anomaliesInput));

    const persistOverride = normalizePersistFlag(body.persist);

    const result = await generateScenario({
      count: body.count,
      anomalies,
      seed: body.seed,
      scenarioPath: body.scenarioPath || body.scenarioFile || body.scenario,
      anomalyRate: body.anomalyRate,
      anomalyCount: body.anomalyCount,
      outputDir: body.outputDir,
      csvFileName: body.csvFileName || body.csvFile,
      manifestFileName: body.manifestFileName || body.manifestFile,
      runId: body.runId,
      persist: persistOverride !== undefined ? persistOverride : undefined,
      startTime: body.startTime,
      sessionSpacingSeconds: body.sessionSpacingSeconds || body.sessionSpacing,
      maxSteps: body.maxSteps,
    });

    res.status(201).json({ data: result });
  })
);

module.exports = router;
module.exports.default = router;
module.exports.__esModule = true;
