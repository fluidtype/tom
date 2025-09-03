import process from 'node:process';

export interface EnvConfig {
  nodeEnv: string;
  port: number;
  corsOrigin: string;
  databaseUrl: string;
  rateLimitPublicMax: number;
  rateLimitWebhookMax: number;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const port = Number(process.env.PORT) || 3000;
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  // Missing critical configuration: without a DB URL the app can't start.
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const rateLimitPublicMax = Number(process.env.RATE_LIMIT_PUBLIC_MAX) || 100;
const rateLimitWebhookMax = Number(process.env.RATE_LIMIT_WEBHOOK_MAX) || 10; // tighter limit for webhook endpoints

const config: EnvConfig = {
  nodeEnv,
  port,
  corsOrigin,
  databaseUrl,
  rateLimitPublicMax,
  rateLimitWebhookMax,
};

export default config;
