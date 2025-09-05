import { CorsOptions } from 'cors';
import { HelmetOptions } from 'helmet';
import rateLimit from 'express-rate-limit';
/* eslint-disable @typescript-eslint/no-explicit-any */

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
    helmetOptions: {
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    },
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
/* eslint-enable @typescript-eslint/no-explicit-any */
