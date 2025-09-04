import { Router, Request, Response } from 'express';

const router = Router();

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

router.get('/', (req: Request<unknown, unknown, unknown, VerifyQuery>, res: Response) => {
  const mode = String(req.query['hub.mode'] ?? '');
  const token = String(req.query['hub.verify_token'] ?? '');
  const challenge = String(req.query['hub.challenge'] ?? '');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    req.log?.info({ mode, hasChallenge: !!challenge }, 'whatsapp webhook verify ok');
    res.status(200).type('text/plain').send(challenge);
  } else {
    req.log?.warn({ mode }, 'whatsapp webhook verify forbidden');
    res.status(403).json({ ok: false, error: 'forbidden' });
  }
});

export default router;
