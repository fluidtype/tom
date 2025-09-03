import type { CorsOptions } from 'cors';
import type { HelmetOptions } from 'helmet';

export const corsOptions: CorsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
};

export const helmetOptions: HelmetOptions = {};
