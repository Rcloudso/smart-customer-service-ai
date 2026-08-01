import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { createConcurrencyLimiter } from '../middleware/concurrencyLimit';
import { toPublicFaqEntry } from '../routes/public-faq.dto';
import { IntentCategory, type FaqEntry } from '../types/domain';

async function listen(app: express.Application): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function testIpv6ClientsShareSubnetKeys(): void {
  assert.equal(
    ipKeyGenerator('2001:db8:1234:5678::1', 56),
    ipKeyGenerator('2001:db8:1234:56ff::2', 56),
  );
}

async function testConcurrencyLimiterRejectsExcessWork(): Promise<void> {
  const app = express();
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

  app.get('/slow', createConcurrencyLimiter(1), async (_req, res) => {
    markStarted();
    await release;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const first = fetch(`${baseUrl}/slow`);
    await started;
    const rejected = await fetch(`${baseUrl}/slow`);
    assert.equal(rejected.status, 503);
    releaseFirst();
    assert.equal((await first).status, 200);
  } finally {
    releaseFirst();
    await close(server);
  }
}

function testPublicFaqDtoOmitsOperationalFields(): void {
  const entry: FaqEntry = {
    id: 'faq-1',
    question: 'Question',
    answer: 'Answer',
    category: IntentCategory.GENERAL,
    keywords: ['public'],
    embedding: [0.1, 0.2],
    embeddingProfile: 'secret-profile',
    isActive: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'admin@example.com',
  };

  assert.deepEqual(toPublicFaqEntry(entry), {
    id: 'faq-1',
    question: 'Question',
    answer: 'Answer',
    category: IntentCategory.GENERAL,
    keywords: ['public'],
  });
}

async function main(): Promise<void> {
  testIpv6ClientsShareSubnetKeys();
  await testConcurrencyLimiterRejectsExcessWork();
  testPublicFaqDtoOmitsOperationalFields();
  console.log('Public API security checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
