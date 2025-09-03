import corsFactory from 'cors';
import helmetFactory from 'helmet';
import rateLimit from 'express-rate-limit';

import env from './env';

export const cors = () =>
  corsFactory({
    origin: env.corsOrigin,
  });

export const helmet = () =>
  helmetFactory();

// General public rate limiter to prevent abuse.
export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.rateLimitPublicMax,
  standardHeaders: true,
  legacyHeaders: false,
});

// Webhook endpoints often need tighter limits and signature verification.
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.rateLimitWebhookMax,
  standardHeaders: true,
  legacyHeaders: false,
});
