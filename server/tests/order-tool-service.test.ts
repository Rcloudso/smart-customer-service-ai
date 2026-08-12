import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, initSchema } from '../db';
import { OrderToolService } from '../services/order-tool.service';
import type { OrderStatusAdapter } from '../types/order-tool';

function seedSession(db: Database.Database, id: string, userIdent: string): void {
  const now = '2026-08-12T00:00:00.000Z';
  db.prepare(
    `INSERT INTO sessions (id, user_ident, status, created_at, updated_at, origin)
     VALUES (?, ?, 'active', ?, ?, 'customer')`,
  ).run(id, userIdent, now, now);
}

function createAdapter(overrides: Partial<OrderStatusAdapter> = {}): OrderStatusAdapter {
  return {
    name: 'test_adapter',
    version: '1',
    async verify() {
      return true;
    },
    async lookup() {
      return {
        orderReferenceMasked: 'RW-••••-1002',
        orderStatus: 'shipped',
        shippingStatus: 'in_transit',
        carrier: 'demo_express',
        trackingNumberMasked: '••••••7890',
        latestEvent: 'departed_origin',
        latestEventAt: '2026-08-12T02:00:00.000Z',
        estimatedDeliveryDate: '2026-08-15',
        dataUpdatedAt: '2026-08-12T02:05:00.000Z',
      };
    },
    ...overrides,
  };
}

async function testUnauthorizedLookupNeverCallsAdapter(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  seedSession(db, 'session-b', 'browser-b');
  let lookupCalls = 0;
  const service = new OrderToolService(db, {
    adapter: createAdapter({
      async lookup() {
        lookupCalls += 1;
        return {};
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 50,
    grantTtlMs: 600_000,
  });

  const grant = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  assert.equal(service.resolveGrant(grant.token, {
    sessionId: 'session-b',
    userIdent: 'browser-b',
  }), null);
  assert.equal(service.resolveGrant('', {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }), null);
  assert.equal(lookupCalls, 0);
  db.close();
}

async function testLookupCallsAdapterOnceAndPersistsOnlySafeSummary(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  let lookupCalls = 0;
  const service = new OrderToolService(db, {
    adapter: createAdapter({
      async lookup(orderReference) {
        lookupCalls += 1;
        assert.equal(orderReference, 'RW-DEMO-1002');
        return createAdapter().lookup(orderReference, Date.now() + 1_000);
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 50,
    grantTtlMs: 600_000,
  });
  const issued = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  const grant = service.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  });
  assert.ok(grant);

  const response = await service.lookup(grant, 'lookup-key-0001');

  assert.equal(lookupCalls, 1);
  assert.equal(response.result.orderStatus, 'shipped');
  assert.match(response.localizedText.zh, /运输/);
  assert.match(response.localizedText.en, /transit/i);
  const execution = db.prepare('SELECT * FROM tool_executions').get() as Record<string, unknown>;
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.masked_order_reference, 'RW-••••-1002');
  assert.equal(JSON.stringify(execution).includes('RW-DEMO-1002'), false);
  const assistant = db.prepare(
    "SELECT content FROM messages WHERE role = 'assistant'",
  ).get() as { content: string };
  assert.match(assistant.content, /再次验证/);
  assert.equal(assistant.content.includes('运输中'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM messages').all()).includes('RW-DEMO-1002'), false);
  db.close();
}

async function testOnlyOneLookupCanRunPerSession(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  let releaseLookup!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let lookupCalls = 0;
  const service = new OrderToolService(db, {
    adapter: createAdapter({
      async lookup(orderReference) {
        lookupCalls += 1;
        await waitForRelease;
        return createAdapter().lookup(orderReference, Date.now() + 1_000);
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 1_000,
    grantTtlMs: 600_000,
  });
  const issued = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  const grant = service.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  });
  assert.ok(grant);

  const first = service.lookup(grant, 'lookup-key-0001');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => service.lookup(grant, 'lookup-key-0002'),
    /already in progress/i,
  );
  assert.equal(lookupCalls, 1);
  releaseLookup();
  await first;
  db.close();
}

async function testUnsafeAdapterResultIsSuppressedAndEscalated(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  const service = new OrderToolService(db, {
    adapter: createAdapter({
      async lookup() {
        return {
          orderReferenceMasked: 'RW-••••-1002',
          orderStatus: 'shipped',
          shippingStatus: 'in_transit',
          carrier: 'free text carrier must fail',
          trackingNumberMasked: '••••••7890',
          latestEvent: 'departed_origin',
          latestEventAt: '2026-08-12T02:00:00.000Z',
          estimatedDeliveryDate: '2026-08-15',
          dataUpdatedAt: '2026-08-12T02:05:00.000Z',
          rawResponse: { secret: true },
        };
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 50,
    grantTtlMs: 600_000,
  });
  const issued = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  const grant = service.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  });
  assert.ok(grant);

  await assert.rejects(() => service.lookup(grant, 'lookup-key-unsafe'), /could not be verified/i);
  const execution = db.prepare(
    'SELECT status, safe_error_code AS safeErrorCode FROM tool_executions',
  ).get() as { status: string; safeErrorCode: string };
  assert.deepEqual(execution, { status: 'failed', safeErrorCode: 'unsafe_adapter_result' });
  const packet = db.prepare(
    'SELECT reason_code AS reasonCode, recommended_queue AS queue FROM escalation_packets',
  ).get() as { reasonCode: string; queue: string };
  assert.deepEqual(packet, { reasonCode: 'unsafe_tool_result', queue: 'order_support' });
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE content LIKE '%运输中%'").get(),
    { count: 0 },
  );
  db.close();
}

async function testVerificationRateLimitAndLookupTimeout(): Promise<void> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  let verifyCalls = 0;
  let lookupCalls = 0;
  const service = new OrderToolService(db, {
    adapter: createAdapter({
      async verify() {
        verifyCalls += 1;
        return false;
      },
      async lookup() {
        lookupCalls += 1;
        await new Promise(() => undefined);
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 10,
    grantTtlMs: 600_000,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => service.verify({
        sessionId: 'session-a',
        userIdent: 'browser-a',
        orderReference: 'RW-DEMO-1002',
        verificationCode: '000000',
      }),
      /订单号或验证码无效/,
    );
  }
  await assert.rejects(
    () => service.verify({
      sessionId: 'session-a',
      userIdent: 'browser-a',
      orderReference: 'RW-DEMO-1002',
      verificationCode: '000000',
    }),
    /尝试过多/,
  );
  assert.equal(verifyCalls, 5);

  const lookupService = new OrderToolService(db, {
    adapter: createAdapter({
      async lookup() {
        lookupCalls += 1;
        await new Promise(() => undefined);
      },
    }),
    secret: 'order-tool-service-secret',
    timeoutMs: 10,
    grantTtlMs: 600_000,
  });
  const issued = await lookupService.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  const grant = lookupService.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  });
  assert.ok(grant);
  await assert.rejects(() => lookupService.lookup(grant, 'lookup-key-timeout'), /unavailable/i);
  assert.equal(lookupCalls, 1);
  assert.deepEqual(
    db.prepare(
      `SELECT status, safe_error_code AS safeErrorCode
       FROM tool_executions ORDER BY created_at DESC LIMIT 1`,
    ).get(),
    { status: 'failed', safeErrorCode: 'adapter_timeout' },
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM escalation_log').get() as { count: number }).count,
    0,
  );
  db.close();
}

async function main(): Promise<void> {
  await testUnauthorizedLookupNeverCallsAdapter();
  await testLookupCallsAdapterOnceAndPersistsOnlySafeSummary();
  await testOnlyOneLookupCanRunPerSession();
  await testUnsafeAdapterResultIsSuppressedAndEscalated();
  await testVerificationRateLimitAndLookupTimeout();
  console.log('Order tool service checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
    const configuredPath = process.env.DB_PATH;
    if (!configuredPath) return;
    const databasePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });
