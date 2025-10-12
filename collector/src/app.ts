import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
// @ts-expect-error -- third-party module lacks bundled type declarations
import cors, { type CorsOptions, type CorsOriginCallback } from 'cors';
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

const corsOrigins = Array.isArray(config.cors.allowedOrigins)
  ? (config.cors.allowedOrigins as string[])
  : [];

const corsOptions: CorsOptions = {
  origin: (origin: string | undefined, callback: CorsOriginCallback): void => {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.disable('x-powered-by');
app.use(cors(corsOptions));
app.use(express.json({ limit: config.requestLimit as string | number }));
app.use(express.urlencoded({ extended: false }));
app.use(requestLogger);
app.use(csvSinkMiddleware);

app.use(['/api/v1/health', '/healthz'], healthRoutes);
app.use(['/api/v1/metrics', '/metrics'], metricsRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/simulations', simulationRoutes);

app.use((req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not Found' });
});

app.use(errorHandler);

const start = async (): Promise<Server> => {
  await createSchema();
  ntpMonitor.start();
  return new Promise<Server>((resolve) => {
    const server = app.listen(config.port, () => {
      logger.info(`Log server listening on port ${config.port}`);
      resolve(server);
    });
  });
};

process.once('SIGTERM', () => {
  ntpMonitor.stop();
});

export { app, start };
export default app;
