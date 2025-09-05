import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';

const router = Router();

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

// GET verify (Meta challenge)
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

// --- Schemi Zod per payload WA ---
const WaTextMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const WaChangeValueSchema = z.object({
  messages: z.array(WaTextMessageSchema).optional(),
  statuses: z.array(z.any()).optional(),
  metadata: z
    .object({
      display_phone_number: z.string().optional(),
      phone_number_id: z.string().optional(),
    })
    .optional(),
  contacts: z
    .array(
      z.object({
        wa_id: z.string().optional(),
        profile: z.object({ name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

const WaEntrySchema = z.object({
  id: z.string().optional(),
  changes: z.array(z.object({ value: WaChangeValueSchema, field: z.string().optional() })),
});

const WaWebhookSchema = z.object({
  object: z.string(),
  entry: z.array(WaEntrySchema),
});

// POST webhook (ACK + idempotenza)
router.post('/', async (req: Request, res: Response) => {
  // 1) ACK immediato
  res.status(200).json({ ok: true });

  // process asynchronously
  setImmediate(async () => {
    // 2) Validazione sicura
    const parse = WaWebhookSchema.safeParse(req.body);
    if (!parse.success) {
      req.log?.warn({ zodError: parse.error.flatten() }, 'wa webhook invalid payload');
      return;
    }

    // 3) Filtra solo eventi WA
    if (parse.data.object !== 'whatsapp_business_account') {
      req.log?.warn({ object: parse.data.object }, 'ignored non-WABA object');
      return;
    }

    // 4) Resolve tenant
    const slug = (req.header('X-Tenant') || 'demo').trim();
    let tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) tenant = await prisma.tenant.findUnique({ where: { slug: 'demo' } });
    if (!tenant) {
      req.log?.error({ slug }, 'no tenant resolved for webhook');
      return;
    }

    // 5) Cicla gli entry/messages
    try {
      const { entry } = parse.data;
      for (const e of entry) {
        for (const ch of e.changes) {
          const val = ch.value;
          if (!Array.isArray(val?.messages)) continue;
          for (const m of val.messages) {
            if (m.type !== 'text') continue;

            const messageId = m.id;
            const from = m.from;
            const body = m.text.body ?? '';

            // Idempotenza
            try {
              await prisma.processedWebhook.create({
                data: {
                  tenantId: tenant.id,
                  provider: 'whatsapp',
                  messageId,
                },
              });
            } catch (err: unknown) {
              const e = err as { code?: string };
              if (e?.code === 'P2002') {
                req.log?.info({ messageId }, 'duplicate webhook skipped');
                continue;
              }
              req.log?.error({ err: e, messageId }, 'failed to persist ProcessedWebhook');
              continue;
            }

            // Echo
            req.log?.info(
              { tenant: tenant.slug, messageId, from, body },
              'WA inbound text processed',
            );
          }
        }
      }
    } catch (err) {
      req.log?.error({ err }, 'wa webhook processing error');
    }
  });
});

export default router;
