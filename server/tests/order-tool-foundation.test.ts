import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveOrderToolEnvironment } from '../config';
import { initSchema } from '../db';
import { OrderAccessGrantRepo } from '../db/repos/order-access-grant.repo';
import { OrderGrantService } from '../services/order-grant.service';
import {
  DemoOrderStatusAdapter,
  DEMO_INVALID_ORDER,
  DEMO_TIMEOUT_ORDER,
  ORDER_STATUS_TOOL_NAME,
  ORDER_STATUS_TOOL_VERSION,
  validateOrderStatusResult,
} from '../tools/order-status';

const TEST_SECRET = 'order-tools-test-secret';

async function testDemoAdapterReturnsOnlyNormalizedSafeResults(): Promise<void> {
  const adapter = new DemoOrderStatusAdapter();
  const fixtures = [
    ['RW-DEMO-1001', '246810', 'processing', 'not_shipped'],
    ['RW-DEMO-1002', '135790', 'shipped', 'in_transit'],
    ['RW-DEMO-1003', '112233', 'delivered', 'delivered'],
    ['RW-DEMO-1004', '445566', 'exception', 'exception'],
  ] as const;

  for (const [reference, code, orderStatus, shippingStatus] of fixtures) {
    assert.equal(await adapter.verify(reference, code), true);
    const raw = await adapter.lookup(reference, Date.now() + 3_000);
    const result = validateOrderStatusResult(raw);
    assert.equal(result.orderStatus, orderStatus);
    assert.equal(result.shippingStatus, shippingStatus);
    assert.equal(result.orderReferenceMasked.includes(reference), false);
    assert.equal(JSON.stringify(result).includes(reference), false);
    assert.equal(JSON.stringify(result).includes(code), false);
    assert.equal('recipient' in result, false);
    assert.equal('address' in result, false);
    assert.equal('rawResponse' in result, false);
  }

  assert.equal(await adapter.verify('RW-DEMO-1002', '000000'), false);
  await assert.rejects(
    () => adapter.lookup('RW-DEMO-9999', Date.now() + 3_000),
    /order_not_found/,
  );
  assert.equal(
    await adapter.verify(DEMO_TIMEOUT_ORDER.orderReference, DEMO_TIMEOUT_ORDER.verificationCode),
    true,
  );
  assert.equal(
    await adapter.verify(DEMO_INVALID_ORDER.orderReference, DEMO_INVALID_ORDER.verificationCode),
    true,
  );
  await assert.rejects(
    async () => validateOrderStatusResult(
      await adapter.lookup(DEMO_INVALID_ORDER.orderReference, Date.now() + 3_000),
    ),
  );
}

function testResultContractRejectsUntrustedProviderFields(): void {
  assert.throws(
    () => validateOrderStatusResult({
      orderReferenceMasked: 'RW-••••-1002',
      orderStatus: 'shipped',
      shippingStatus: 'in_transit',
      carrier: 'demo_express',
      trackingNumberMasked: '••••••7890',
      latestEvent: 'departed_origin',
      latestEventAt: '2026-08-12T02:00:00.000Z',
      estimatedDeliveryDate: '2026-08-15',
      dataUpdatedAt: '2026-08-12T02:05:00.000Z',
      recipient: 'must not cross the adapter boundary',
    }),
    /unrecognized/i,
  );
  assert.throws(
    () => validateOrderStatusResult({
      orderReferenceMasked: 'RW-••••-1002',
      orderStatus: 'shipped',
      shippingStatus: 'in_transit',
      carrier: 'demo_express',
      trackingNumberMasked: 'TRACKING-RAW-7890',
      latestEvent: 'departed_origin',
      latestEventAt: '2026-08-12T02:00:00.000Z',
      estimatedDeliveryDate: '2026-08-15',
      dataUpdatedAt: '2026-08-12T02:05:00.000Z',
    }),
  );
}

function testGrantIsEncryptedBoundAndSingleUseScope(): void {
  const db = new Database(':memory:');
  initSchema(db);
  initSchema(db);
  db.prepare(
    `INSERT INTO sessions (id, user_ident, status, created_at, updated_at, origin)
     VALUES (?, ?, 'active', ?, ?, 'customer')`,
  ).run('session-a', 'browser-a', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');

  const repo = new OrderAccessGrantRepo(db);
  const service = new OrderGrantService(repo, {
    secret: TEST_SECRET,
    ttlMs: 10 * 60 * 1_000,
  });
  const now = new Date('2026-08-12T00:00:00.000Z');
  const first = service.issue({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
  }, now);
  const persisted = db.prepare('SELECT * FROM order_access_grants').get() as Record<string, unknown>;

  assert.equal(first.toolName, ORDER_STATUS_TOOL_NAME);
  assert.equal(first.toolVersion, ORDER_STATUS_TOOL_VERSION);
  assert.equal(first.maskedOrderReference, 'RW-••••-1002');
  assert.equal(JSON.stringify(persisted).includes('RW-DEMO-1002'), false);
  assert.equal(JSON.stringify(persisted).includes(first.token), false);

  const valid = service.resolve(first.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }, new Date('2026-08-12T00:09:59.000Z'));
  assert.equal(valid?.orderReference, 'RW-DEMO-1002');
  assert.equal(valid?.maskedOrderReference, 'RW-••••-1002');
  assert.equal(service.resolve(first.token, {
    sessionId: 'session-a',
    userIdent: 'browser-b',
  }, now), null);
  assert.equal(service.resolve(first.token, {
    sessionId: 'session-b',
    userIdent: 'browser-a',
  }, now), null);
  assert.equal(service.resolve(first.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }, new Date('2026-08-12T00:10:01.000Z')), null);

  const second = service.issue({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1003',
  }, new Date('2026-08-12T00:01:00.000Z'));
  assert.equal(service.resolve(first.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }, new Date('2026-08-12T00:01:01.000Z')), null);
  assert.equal(service.resolve(second.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }, new Date('2026-08-12T00:01:01.000Z'))?.orderReference, 'RW-DEMO-1003');

  db.close();
}

function testStartupRecoversToolState(): void {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO sessions (id, user_ident, status, created_at, updated_at, origin)
     VALUES ('session-a', 'browser-a', 'active', ?, ?, 'customer')`,
  ).run('2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
  db.prepare(
    `INSERT INTO order_access_grants (
       id, token_hash, session_id, user_ident_hash, order_reference_ciphertext,
       order_reference_iv, order_reference_tag, order_reference_fingerprint,
       masked_order_reference, tool_name, tool_version, expires_at, created_at
     ) VALUES ('grant-expired', 'token-hash', 'session-a', 'user-hash', 'cipher',
       'iv', 'tag', 'fingerprint', 'RW-••••-1002', ?, ?, ?, ?)`,
  ).run(
    ORDER_STATUS_TOOL_NAME,
    ORDER_STATUS_TOOL_VERSION,
    '2000-01-01T00:00:00.000Z',
    '2000-01-01T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO tool_executions (
       id, session_id, tool_name, tool_version, adapter_name, adapter_version,
       masked_order_reference, order_reference_fingerprint, status, created_at,
       updated_at
     ) VALUES ('execution-running', 'session-a', ?, ?, 'demo', '1',
       'RW-••••-1002', 'fingerprint', 'running', ?, ?)`,
  ).run(
    ORDER_STATUS_TOOL_NAME,
    ORDER_STATUS_TOOL_VERSION,
    '2000-01-01T00:00:00.000Z',
    '2000-01-01T00:00:00.000Z',
  );

  initSchema(db);

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM order_access_grants').get() as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT status FROM tool_executions WHERE id = 'execution-running'").get() as { status: string }).status,
    'interrupted',
  );
  db.close();
}

function testDemoModeIsProductionOptIn(): void {
  assert.equal(resolveOrderToolEnvironment({}, 'development').provider, 'demo');
  assert.equal(resolveOrderToolEnvironment({}, 'test').provider, 'demo');
  assert.equal(resolveOrderToolEnvironment({}, 'production').provider, 'disabled');
  assert.equal(
    resolveOrderToolEnvironment({ ORDER_TOOL_PROVIDER: 'demo' }, 'production').provider,
    'demo',
  );
}

async function main(): Promise<void> {
  await testDemoAdapterReturnsOnlyNormalizedSafeResults();
  testResultContractRejectsUntrustedProviderFields();
  testGrantIsEncryptedBoundAndSingleUseScope();
  testStartupRecoversToolState();
  testDemoModeIsProductionOptIn();
  console.log('Order tool foundation checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
