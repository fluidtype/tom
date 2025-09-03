import { PrismaClient } from '@prisma/client';
import pino from 'pino';

const logger = pino();

// Reuse PrismaClient instance across hot reloads to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (!process.env.DATABASE_URL) {
  logger.warn('DATABASE_URL is not set. Falling back to default SQLite path.');
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
