const express = require('express');
const logCapture = require('../middleware/logCapture');

const router = express.Router();

router.use(logCapture);

router.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
