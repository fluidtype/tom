import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import config from './config/env';
import logger from './config/logger';
import { corsOptions, helmetOptions } from './config/security';
import rateLimiter from './config/rateLimit';
import healthRouter from './routes/health';
import errorHandler from './middlewares/errorHandler';

const app = express();

app.use(helmet(helmetOptions));
app.use(cors(corsOptions));
app.use(express.json());
app.use(pinoHttp({ logger }));

// Verify webhook signatures on routes handling external callbacks.
// Use idempotency keys on state-changing routes to prevent duplicate work.
// Protect user data with OAuth where appropriate.

app.use(rateLimiter); // Adjust rate limits to balance security and usability.

app.use('/healthz', healthRouter);

app.use(errorHandler);

app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port}`);
});
