import { prisma } from '../config/database.js';
import { r2 } from '../config/r2.js';
import { reconcileDeploymentRoute } from '../services/deployment-routing.js';

async function main(): Promise<void> {
  const result = await reconcileDeploymentRoute(
    'cmw3a0c0f0002w8hyvb01efyr',
    'cmw2hyrtq00005ohy7a56rlxy',
  );

  console.log('Deployment routing result:', result);
}

main()
  .catch((error: unknown) => {
    console.error('Deployment routing check failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    r2.destroy();
    await prisma.$disconnect();
  });
