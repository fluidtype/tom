import { Router } from 'express';
import { version } from '../../package.json';

const router = Router();

router.get('/', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version });
});

export default router;
