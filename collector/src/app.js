const express = require('express');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const eventRoutes = require('./routes/events');
const { csvSinkMiddleware } = require('./index');
const { createSchema } = require('./storage/eventRepository');

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

app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/events', eventRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const start = async () => {
  await createSchema();
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
