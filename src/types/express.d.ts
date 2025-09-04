import type { Tenant } from '@prisma/client';
import type { Logger } from 'pino';

declare global {
  namespace Express {
    // oggetto tenant risolto dal middleware
    interface Request {
      tenant?: Tenant;
      log?: Logger;
      id?: string; // correlation id
    }
  }
}
export {};
