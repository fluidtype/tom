import { Router, Request, Response } from 'express';
import { parseBookingIntent } from '../services/openai/nlu';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const text = String(req.query.text || '');
  if (!text) {
    return res.status(400).json({ ok: false, error: 'missing text' });
  }
  const phone = req.header('X-Phone') || undefined;
  const result = await parseBookingIntent(text, {
    phone,
    tenantName: req.tenant?.name,
    locale: process.env.LOCALE,
    timezone: process.env.TIMEZONE,
  });
  return res.json(result);
});

export default router;
