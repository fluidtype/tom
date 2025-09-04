import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import pinoHttp from 'pino-http';
import logger from './config/logger';

import { createHttpConfig, publicLimiter /* , webhookLimiter */ } from './config/http';
import healthRouter from './routes/health';
import { errorHandler } from './middlewares/errorHandler';
import { tenantResolver } from './middlewares/tenantResolver';
import whoami from './routes/whoami';

const app = express();

app.set('trust proxy', true);
app.disable('x-powered-by');

// HTTP hardening
const { corsOptions, helmetOptions } = createHttpConfig();
app.use(helmet(helmetOptions));
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Correlation ID
app.use((req, _res, next) => {
  const id = req.header('x-request-id') || crypto.randomUUID();
  req.id = id;
  next();
});

// pino-http centralizzato
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.body.password',
        'req.body.token',
      ],
      remove: true,
    },
    autoLogging: {
      ignore: (req) => req.url === '/healthz',
    },
  }),
);

// Healthcheck con rate limit pubblico
app.use('/healthz', publicLimiter, healthRouter);

// da qui in poi rotte “business” che richiedono il tenant
app.use(tenantResolver);
app.use('/whoami', whoami);

// TODO: app.use('/webhook/whatsapp', webhookLimiter, webhookRouter);

// Error handler (ultimo)
app.use(errorHandler);

// Avvio
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Server started');
});
