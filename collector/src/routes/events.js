const express = require('express');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const logService = require('../services/logService');

const router = express.Router();

router.post(
  '/',
  auth,
  asyncHandler(async (req, res) => {
    const event = await logService.ingestEvent(req.body || {});
    res.status(201).json({ data: event });
  })
);

router.post(
  '/batch',
  auth,
  asyncHandler(async (req, res) => {
    const events = await logService.ingestBatch(req.body || []);
    res.status(201).json({ data: { inserted: events.length } });
  })
);

router.get(
  '/',
  auth,
  asyncHandler(async (req, res) => {
    const result = await logService.listEvents(req.query || {});
    res.json({ data: result });
  })
);

router.get(
  '/sessions/:sessionId',
  auth,
  asyncHandler(async (req, res) => {
    const result = await logService.listEvents({
      ...req.query,
      session_id: req.params.sessionId,
    });
    res.json({ data: result });
  })
);

module.exports = router;
