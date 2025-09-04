import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import logger from '../src/config/logger';

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
  logger.info('Seed ok: tenant demo creato/aggiornato');
}

main()
  .catch((e) => {
    logger.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
