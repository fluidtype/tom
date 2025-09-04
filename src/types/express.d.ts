import type { Tenant } from '@prisma/client';

declare global {
  namespace Express {
    // oggetto tenant risolto dal middleware
    interface Request {
      tenant?: Tenant;
    }
  }
}
export {};
