const express = require('express');
const auth = require('../middleware/auth');
const logCapture = require('../middleware/logCapture');
const asyncHandler = require('../utils/asyncHandler');
const logService = require('../services/logService');

const router = express.Router();

router.use(auth);
router.use(logCapture);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const event = await logService.ingestEvent(req.body || {});
    res.status(201).json({ data: event });
  })
);

router.post(
  '/batch',
  asyncHandler(async (req, res) => {
    const events = await logService.ingestBatch(req.body || []);
    res.status(201).json({ data: { inserted: events.length } });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await logService.listEvents(req.query || {});
    res.json({ data: result });
  })
);

router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const result = await logService.listEvents({
      ...req.query,
      session_id: req.params.sessionId,
    });
    res.json({ data: result });
  })
);

module.exports = router;
