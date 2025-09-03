import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { createHttpConfig } from './config/http';
import healthRouter from './routes/health';
import { errorHandler } from './middlewares/errorHandler';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const app = express();

// HTTP hardening + CORS + logging
const { corsOptions, helmetOptions } = createHttpConfig();
app.use(helmet(helmetOptions));
app.use(cors(corsOptions));
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// Body parser
app.use(express.json());

// Healthcheck
app.use('/healthz', healthRouter);

// Error handler (ultimo)
app.use(errorHandler);

// Avvio
const PORT = Number(process.env.PORT || 3000);
app.set('trust proxy', true);
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Server started');
});
