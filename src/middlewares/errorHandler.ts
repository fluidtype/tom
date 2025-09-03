import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const logger = pino();

interface AppError {
  statusCode?: number;
  status?: number;
  message?: string;
  code?: string;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const error = err as AppError;
  const status = error.statusCode || error.status || 500;
  logger.error({ err, status }, 'Unhandled error');
  res.status(status).json({
    ok: false,
    error: {
      message: error.message || 'Internal Server Error',
      code: error.code || 'INTERNAL_ERROR',
    },
  });
}
