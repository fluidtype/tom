import cors, { CorsOptions } from 'cors';
import helmet, { HelmetOptions } from 'helmet';

export const corsOptions: CorsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
};

export const helmetOptions: HelmetOptions = {};
