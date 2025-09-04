import { CorsOptions } from 'cors';
import { HelmetOptions } from 'helmet';
import rateLimit from 'express-rate-limit';

import { env } from './env';

export function createHttpConfig(): {
  corsOptions: CorsOptions;
  helmetOptions: HelmetOptions;
} {
  return {
    corsOptions: {
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant', 'X-Request-Id'],
      credentials: false,
    },
    // Base Helmet configuration; extend with stricter policies as needed
    helmetOptions: {},
  };
}

export const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true, // ✅
} as any);

export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true, // ✅
} as any);
