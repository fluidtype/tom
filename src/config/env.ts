import process from 'node:process';
import logger from './logger';

const required = ['NODE_ENV', 'PORT', 'DATABASE_URL'] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  logger.error({ missing }, 'Missing required environment variables');
  process.exit(1);
}

export const env = {
  NODE_ENV: process.env.NODE_ENV!,
  PORT: parseInt(process.env.PORT!, 10),
  DATABASE_URL: process.env.DATABASE_URL!,
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',
};

export type Env = typeof env;
