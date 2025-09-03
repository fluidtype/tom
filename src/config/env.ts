import process from 'node:process';

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '3000', 10),
  DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? '*',
};

export type Env = typeof env;
