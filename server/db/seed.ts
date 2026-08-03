import bcrypt from 'bcrypt';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDatabase } from './index';
import { AdminRepo } from './repos/admin.repo';

/**
 * Synchronize the single environment-managed administrator.
 *
 * v0.3.4 intentionally does not install sample knowledge here. Demo FAQs and
 * the return-policy document are loaded explicitly from Getting Started.
 */
export async function seed(): Promise<void> {
  logger.info('Starting database seed...');
  const db = getDatabase();
  const adminRepo = new AdminRepo(db);
  const admins = adminRepo.listAll();
  const configuredAdmin = admins.find((admin) => admin.username === config.admin.username);
  const targetAdmin = configuredAdmin ?? admins[0] ?? null;
  const passwordMatches = targetAdmin
    ? await bcrypt.compare(config.admin.password, targetAdmin.passwordHash)
    : false;
  const passwordHash = passwordMatches
    ? targetAdmin!.passwordHash
    : await bcrypt.hash(config.admin.password, 10);

  const synchronizeAdmin = db.transaction(() => {
    let adminId: string;
    if (targetAdmin) {
      adminRepo.updateIdentityAndPassword(
        targetAdmin.id,
        config.admin.username,
        passwordHash,
      );
      adminId = targetAdmin.id;
    } else {
      adminId = adminRepo.create(config.admin.username, passwordHash).id;
    }
    return adminRepo.deleteAllExcept(adminId);
  });
  const removedStaleAdmins = synchronizeAdmin();
  logger.info(
    { username: config.admin.username, removedStaleAdmins },
    'Environment-managed admin synchronized',
  );
  logger.info('Database seed completed');
}

if (require.main === module) {
  seed()
    .then(() => {
      logger.info('Seed finished successfully');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
