import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import pinoHttp from 'pino-http';
import logger from './config/logger';

import { createHttpConfig, publicLimiter, webhookLimiter } from './config/http';
import healthRouter from './routes/health';
import whatsappWebhook from './routes/webhook.whatsapp';
import { errorHandler } from './middlewares/errorHandler';
import { tenantResolver } from './middlewares/tenantResolver';
import whoami from './routes/whoami';
import nluRouter from './routes/nlu';
import availabilityRouter from './routes/availability';

const app = express();

// Con proxy (ngrok) fidati del primo hop
app.set('trust proxy', 1);
// in alternativa locale puro: 'loopback'
// app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

// HTTP hardening
const { corsOptions, helmetOptions } = createHttpConfig();
app.use(helmet(helmetOptions));
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '1mb' }));

// Correlation ID
app.use((req, _res, next) => {
  const id = req.header('x-request-id') || crypto.randomUUID();
  req.id = id;
  next();
});

// expose request id
app.use((req, res, next) => {
  if (typeof req.id === 'string') res.setHeader('x-request-id', req.id);
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

// Webhook WhatsApp (no tenant resolver)
app.use('/webhook/whatsapp', webhookLimiter, whatsappWebhook);

// Availability PRIMA del tenantResolver
app.use('/availability', availabilityRouter);

// da qui in poi rotte “business” che richiedono il tenant
app.use(tenantResolver);
app.use('/nlu', nluRouter);
app.use('/whoami', whoami);

// 404 handler
app.use((req, res) => {
  res
    .status(404)
    .json({ ok: false, error: { message: 'Not Found', code: 'NOT_FOUND' } });
});

// Error handler (ultimo)
app.use(errorHandler);

// Avvio
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Server started');
});
