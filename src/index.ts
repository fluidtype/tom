import dotenv from 'dotenv';
import express from 'express';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import logger from './config/logger';
import { cors, helmet, publicLimiter } from './config/http';
import healthRouter from './routes/health';
import { errorHandler } from './middlewares/errorHandler';

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));

// Verify webhook signatures on routes handling external callbacks.
// Apply webhookLimiter where webhooks are received to prevent abuse.
// Use idempotency keys on state-changing routes to prevent duplicate work.
// Protect user data with OAuth where appropriate.

app.use(publicLimiter); // Adjust rate limits to balance security and usability.

app.use('/healthz', healthRouter);

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info(`Server listening on port ${env.PORT}`);
});
