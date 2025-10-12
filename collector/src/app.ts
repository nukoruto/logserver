import type {} from './types/external';

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import type { Server } from 'http';
import config from './config';
import logger from './utils/logger';
import requestLogger from './middleware/requestLogger';
import errorHandler from './middleware/errorHandler';
import healthRoutes from './routes/health';
import metricsRoutes from './routes/metrics';
import eventRoutes from './routes/events';
import simulationRoutes from './routes/simulations';
import { csvSinkMiddleware } from './index';
import { createSchema } from './storage/eventRepository';
import { ntpMonitor } from './services/ntpMonitor';

const app: Express = express();

const corsOrigins = config.cors.allowedOrigins;
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
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

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const start = async (): Promise<Server> => {
  await createSchema();
  ntpMonitor.start();
  return await new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      logger.info(`Log server listening on port ${config.port}`);
      resolve(server);
    });
  });
};

export { app, start };

process.once('SIGTERM', () => {
  ntpMonitor.stop();
});
