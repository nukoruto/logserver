const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const metricsRoutes = require('./routes/metrics');
const eventRoutes = require('./routes/events');
const simulationRoutes = require('./routes/simulations');
const { csvSinkMiddleware } = require('./index');
const { createSchema } = require('./storage/eventRepository');
const { ntpMonitor } = require('./services/ntpMonitor');

const app = express();

const corsOrigins = config.cors.allowedOrigins;
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
};

app.disable('x-powered-by');
app.use(cors(corsOptions));
app.use(express.json({ limit: config.requestLimit }));
app.use(express.urlencoded({ extended: false }));
app.use(requestLogger);
app.use(csvSinkMiddleware);

app.use(['/api/v1/health', '/healthz'], healthRoutes);
app.use(['/api/v1/metrics', '/metrics'], metricsRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/simulations', simulationRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const start = async () => {
  await createSchema();
  ntpMonitor.start();
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      logger.info(`Log server listening on port ${config.port}`);
      resolve(server);
    });
  });
};

module.exports = {
  app,
  start,
};

process.once('SIGTERM', () => {
  ntpMonitor.stop();
});
