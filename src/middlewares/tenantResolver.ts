import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db/client';

export async function tenantResolver(req: Request, res: Response, next: NextFunction) {
  try {
    const slug = (req.header('X-Tenant') || '').trim();
    if (!slug) {
      return res.status(400).json({ error: 'Missing X-Tenant header' });
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      return res.status(404).json({ error: `Tenant '${slug}' not found` });
    }

    req.tenant = tenant;

    // opzionale: arricchisci il logger per-request se presente
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (req.log?.child) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      req.log = req.log.child({ tenant: tenant.slug });
    }

    return next();
  } catch (err) {
    // lascia la formattazione all'error handler globale
    return next(err);
  }
}
