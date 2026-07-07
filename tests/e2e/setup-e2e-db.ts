import fs from 'fs';
import path from 'path';

process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'test-secret-123';
process.env.ADMIN_USERNAME ??= 'admin';
process.env.ADMIN_PASSWORD ??= 'admin123';
process.env.EMBED_PROVIDER ??= 'other';
process.env.DB_PATH ??= './data/e2e-test.db';
process.env.RATE_LIMIT_CHAT ??= '200';
process.env.RATE_LIMIT_ADMIN ??= '500';
process.env.RATE_LIMIT_LOGIN ??= '500';

async function main(): Promise<void> {
  const dbPath = path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.resolve(process.cwd(), process.env.DB_PATH);

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }

  const { seed } = await import('../../server/db/seed');
  const { closeDatabase } = await import('../../server/db');

  await seed();
  closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
