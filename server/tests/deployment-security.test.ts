import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcrypt';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-security-'));
const dbPath = path.join(tempDir, 'customer-service.db');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'deployment-test-secret';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'first-strong-password';
process.env.DB_PATH = dbPath;
process.env.EMBED_PROVIDER = 'other';

async function testComposeRequiresSecretsAndBindsLocalPorts(): Promise<void> {
  const compose = fs.readFileSync(path.resolve('docker-compose.yml'), 'utf8');

  assert.match(compose, /JWT_SECRET:\s*\$\{JWT_SECRET:\?[^}]+\}/);
  assert.match(compose, /ADMIN_PASSWORD:\s*\$\{ADMIN_PASSWORD:\?[^}]+\}/);
  assert.doesNotMatch(compose, /change-this-local-secret|ADMIN_PASSWORD:\s*admin123/);
  assert.match(compose, /127\.0\.0\.1:5173:5173/);
  assert.match(compose, /127\.0\.0\.1:3001:3001/);
  assert.match(compose, /ocr-worker:[\s\S]*restart:\s*unless-stopped/);
}

async function testSeedRotatesExistingAdminPassword(): Promise<void> {
  const [databaseModule, { seed }, { AdminRepo }, { config }] = await Promise.all([
    import('../db'),
    import('../db/seed'),
    import('../db/repos/admin.repo'),
    import('../config'),
  ]);

  await seed();
  const db = databaseModule.getDatabase();
  const repo = new AdminRepo(db);
  const initialAdmin = repo.findByUsername('admin');
  assert(initialAdmin);
  assert.equal(await bcrypt.compare('first-strong-password', initialAdmin.passwordHash), true);

  config.admin.password = 'rotated-strong-password';
  await seed();

  const rotatedAdmin = repo.findByUsername('admin');
  assert(rotatedAdmin);
  assert.equal(await bcrypt.compare('rotated-strong-password', rotatedAdmin.passwordHash), true);
  assert.equal(await bcrypt.compare('first-strong-password', rotatedAdmin.passwordHash), false);

  config.admin.username = 'renamed-admin';
  config.admin.password = 'renamed-strong-password';
  await seed();

  assert.equal(repo.findByUsername('admin'), null);
  const renamedAdmin = repo.findByUsername('renamed-admin');
  assert(renamedAdmin);
  assert.equal(await bcrypt.compare('renamed-strong-password', renamedAdmin.passwordHash), true);
  assert.equal(repo.count(), 1);

  repo.create('stale-admin', await bcrypt.hash('known-stale-password', 10));
  assert.equal(repo.count(), 2);
  await seed();
  assert.equal(repo.findByUsername('stale-admin'), null);
  assert.equal(repo.count(), 1);

  databaseModule.closeDatabase();
}

async function main(): Promise<void> {
  try {
    await testComposeRequiresSecretsAndBindsLocalPorts();
    await testSeedRotatesExistingAdminPassword();
    console.log('Deployment security checks passed');
  } finally {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmdirSync(tempDir);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
