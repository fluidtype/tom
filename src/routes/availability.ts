import { Router } from 'express';
import { checkAvailability } from '../services/booking/availability';
import { tenantRules } from '../services/booking/rules.index';

const router = Router();

router.get('/', async (req, res) => {
  // prendi lo slug del tenant dalla request (se c'è)
  let tenant =
    req.tenant?.slug || req.header('X-Tenant')?.trim() || 'demo';

  // se non ci sono regole per il tenant → fallback a demo
  if (!tenantRules[tenant]) {
    console.warn(`⚠️ Tenant "${tenant}" non ha regole, uso fallback "demo"`);
    tenant = 'demo';
  }

  // log utile per debug
  console.log('Tenant slug usato per availability:', tenant);

  const { date, time, people } = req.query;

  if (!date || !time || !people) {
    return res.status(400).json({ ok: false, error: 'missing_params' });
  }

  const result = await checkAvailability(
    tenant,
    String(date),
    String(time),
    Number(people),
  );

  res.json(result);
});

export default router;
