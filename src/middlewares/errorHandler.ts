import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

interface HttpError {
  status?: number;
  message?: string;
}

export default function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const { status = 500, message = 'Internal Server Error' } =
    (err as HttpError) || {};

  if (status >= 500) {
    logger.error({ err }, 'Unhandled error');
  } else {
    logger.warn({ err }, 'Handled error');
  }

  res.status(status).json({ error: message });
}
