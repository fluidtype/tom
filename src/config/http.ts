import corsFactory from 'cors';
import helmetFactory from 'helmet';
import rateLimit from 'express-rate-limit';

import { env } from './env';

export const cors = () =>
  corsFactory({
    origin: env.CORS_ORIGIN,
  });

export const helmet = () => helmetFactory();

export const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
