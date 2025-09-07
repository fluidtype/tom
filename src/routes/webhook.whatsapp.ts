import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { processInboundText } from '../services/booking/booking.service';
import { sendTextMessage } from '../services/whatsapp';

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

// resolve tenant via metadata phone_number_id, header, or fallback demo
async function resolveTenant(slugHeader: string | undefined, phoneNumberId: string | undefined) {
  if (phoneNumberId) {
    const byPhone = await prisma.tenant.findFirst({ where: { whatsappPhoneId: phoneNumberId } });
    if (byPhone) return { tenant: byPhone, resolveVia: 'metadata' as const };
  }

  if (slugHeader) {
    const bySlug = await prisma.tenant.findUnique({ where: { slug: slugHeader.trim() } });
    if (bySlug) return { tenant: bySlug, resolveVia: 'header' as const };
  }

  const demo = await prisma.tenant.findUnique({ where: { slug: 'demo' } });
  if (demo) return { tenant: demo, resolveVia: 'fallback-demo' as const };

  return { tenant: null, resolveVia: 'none' as const };
}

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

    // 4) Cicla gli entry/messages
    try {
      const { entry } = parse.data;
      for (const e of entry) {
        for (const ch of e.changes) {
          const val = ch.value;

          const phoneNumberId = val?.metadata?.phone_number_id;
          const slugHeader = req.header('X-Tenant') || undefined;
          const { tenant, resolveVia } = await resolveTenant(slugHeader, phoneNumberId);
          if (!tenant) {
            req.log?.error({ phoneNumberId, slugHeader }, 'no tenant resolved for webhook');
            continue;
          }

          if (!Array.isArray(val?.messages)) continue;

          for (const m of val.messages) {
            let body: string | undefined;
            const mAny = m as any;
            if (m.type === 'text') {
              body = mAny.text.body ?? '';
            } else if (m.type === 'interactive') {
              const itype = mAny.interactive?.type;
              if (itype === 'button_reply') {
                const id = mAny.interactive.button_reply?.id;
                if (id === 'confirm') body = 'confermo';
                else if (id === 'cancel') body = 'annulla';
              } else if (itype === 'list_reply') {
                const id = mAny.interactive.list_reply?.id;
                if (id && id.startsWith('slot_')) body = id.replace('slot_', '');
              }
            }
            if (!body) continue;

            const messageId = m.id;
            const from = m.from;

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

            try {
              await processInboundText({
                tenant,
                from,
                body,
                messageId,
                log: req.log,
              });
            } catch (err) {
              req.log?.warn({ err, messageId }, 'openai nlu warn');
              const phoneNumberId =
                tenant.whatsappPhoneId || process.env.WHATSAPP_PHONE_NUMBER_ID;
              const token = tenant.whatsappToken || process.env.WHATSAPP_TOKEN;
              if (phoneNumberId && token) {
                await sendTextMessage({
                  to: from,
                  body: 'Scusami, non ho colto tutto. Quante persone siete?',
                  phoneNumberId,
                  token,
                  log: req.log,
                });
              }
            }

            req.log?.info(
              { tenant: tenant.slug, resolveVia, phoneNumberId, messageId, from, body },
              'WA inbound text processed'
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
