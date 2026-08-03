import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-api-'));
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'operations-api-secret';
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.LLM_PROVIDER = 'other';
  process.env.LLM_API_KEY = '';
  process.env.EMBED_PROVIDER = 'other';
  process.env.EMBED_API_KEY = '';
  process.env.VECTOR_STORE_PROVIDER = 'memory';
  process.env.QDRANT_URL = '';
  process.env.OCR_SERVICE_URL = '';

  const [
    { default: operationsRoutes },
    { default: qualityRoutes },
    { errorHandler },
    databaseModule,
    { getQualityLabService },
    { getQualityRunService },
    { QualityRunRepo },
    { QUALITY_BASELINE_VERSION_ID },
  ] = await Promise.all([
    import('../routes/admin/operations'),
    import('../routes/admin/quality'),
    import('../middleware/errorHandler'),
    import('../db'),
    import('../services/quality-lab.service'),
    import('../services/quality-run.service'),
    import('../db/repos/quality-run.repo'),
    import('../eval/quality-baseline'),
  ]);
  const db = databaseModule.getDatabase();
  getQualityLabService().bootstrap();
  const original = getQualityRunService().createRun({
    datasetVersionIds: [QUALITY_BASELINE_VERSION_ID],
    policies: [],
    backendTargets: [{ provider: 'memory' }],
    createdBy: 'test',
  });
  new QualityRunRepo(db).markFailed(original.id, 'simulated_failure', new Date().toISOString());

  const app = express();
  app.use(express.json());
  app.use('/api/admin/operations', operationsRoutes);
  app.use('/api/admin/quality', qualityRoutes);
  app.use(errorHandler);
  const token = jwt.sign(
    { id: 'admin-id', username: 'admin', role: 'admin' },
    process.env.JWT_SECRET,
  );
  const auth = { Authorization: `Bearer ${token}` };
  let server: Server | null = null;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/admin/operations/overview`)).status, 401);
    const overview = await fetch(`${base}/api/admin/operations/overview`, { headers: auth });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as {
      data: { recentProblems: unknown[]; limits: { recentProblems: number } };
    };
    assert.ok(overviewBody.data.recentProblems.length <= overviewBody.data.limits.recentProblems);

    const rerunUrl = `${base}/api/admin/quality/runs/${original.id}/rerun`;
    assert.equal((await fetch(rerunUrl, { method: 'POST', headers: auth })).status, 400);
    const rerun = await fetch(rerunUrl, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'quality-rerun-test-v1' },
    });
    assert.equal(rerun.status, 202);
    const rerunBody = await rerun.json() as { data: { id: string; status: string } };
    assert.notEqual(rerunBody.data.id, original.id);
    assert.equal(rerunBody.data.status, 'queued');
    const replay = await fetch(rerunUrl, {
      method: 'POST',
      headers: { ...auth, 'Idempotency-Key': 'quality-rerun-test-v1' },
    });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    databaseModule.closeDatabase();
  }
}

void main().then(() => console.log('operations API tests passed'));
