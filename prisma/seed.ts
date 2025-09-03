import { prisma } from '../src/db/client';

async function main() {
  const slug = 'demo';
  await prisma.tenant.upsert({ // idempotent seed ensures reruns are safe
    where: { slug },
    update: {},
    create: { slug },
  });
  console.log(`Seeded tenant: ${slug}`);
}

main()
  .catch((e) => {
    console.error('Error seeding database', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
