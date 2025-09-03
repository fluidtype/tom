import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // crea un tenant demo se non esiste
  await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Restaurant',
      slug: 'demo',
      gcalPrimaryId: 'primary',
    },
  });
  console.log('Seed ok: tenant demo creato/aggiornato');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
