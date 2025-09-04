import type { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

type AppError = Error & { statusCode?: number; status?: number; code?: string };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const error = err as AppError;
  const status = error.statusCode || error.status || 500;

  logger.error({ err: error, status, reqId: req.id }, 'Unhandled error');

  const isServer = status >= 500;
  res.status(status).json({
    ok: false,
    error: {
      message: isServer ? 'Internal Server Error' : error.message || 'Request error',
      code: error.code || (isServer ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    },
  });
}
