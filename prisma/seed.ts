import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;

  await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: {
      name: 'Demo Restaurant',
      ...(phoneId ? { whatsappPhoneId: phoneId } : {}),
    },
    create: {
      slug: 'demo',
      name: 'Demo Restaurant',
      ...(phoneId ? { whatsappPhoneId: phoneId } : {}),
    },
  });

  console.log(
    JSON.stringify({ level: 30, msg: 'Seed ok: tenant demo creato/aggiornato' })
  );
}

main().finally(() => prisma.$disconnect());
