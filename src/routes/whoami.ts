import { Router, Request, Response } from 'express';

const r = Router();

// richiede tenantResolver a monte
r.get('/', (req: Request, res: Response) => {
  if (!req.tenant) return res.status(500).json({ error: 'tenant not resolved' });
  const { id, slug, name, createdAt } = req.tenant;
  return res.json({ ok: true, tenant: { id, slug, name, createdAt } });
});

export default r;
