import { PrismaClient } from "@prisma/client";
import { seedProjectWorkflow } from "../lib/projects/seed-projects";

const prisma = new PrismaClient();

async function main() {
  await seedProjectWorkflow(prisma);
  console.log("Project workflow seeded");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
