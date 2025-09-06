import { Router } from 'express';
import { checkAvailability } from '../services/booking/availability';

const router = Router();

router.get('/', (req, res) => {
  const tenant = req.tenant?.slug || 'demo';
  const { date, time, people } = req.query;

  if (!date || !time || !people) {
    return res.status(400).json({ ok: false, error: 'missing_params' });
  }

  const result = checkAvailability(
    tenant,
    String(date),
    String(time),
    Number(people),
  );
  res.json(result);
});

export default router;
