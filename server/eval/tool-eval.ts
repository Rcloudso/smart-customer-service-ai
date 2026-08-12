import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, initSchema } from '../db';
import { OrderToolService } from '../services/order-tool.service';
import { planOrderToolRoute } from '../tools/order-routing';
import {
  DemoOrderStatusAdapter,
  DEMO_INVALID_ORDER,
  DEMO_TIMEOUT_ORDER,
} from '../tools/order-status';
import type { OrderStatusAdapter, OrderStatusResult } from '../types/order-tool';

interface ToolEvaluationFixture {
  version: string;
  routeCases: Array<{
    id: string;
    text: string;
    expectedKind: ReturnType<typeof planOrderToolRoute>['kind'];
  }>;
  demoCases: Array<{
    orderReference: string;
    verificationCode: string;
    expectedOrderStatus: OrderStatusResult['orderStatus'];
    expectedShippingStatus: OrderStatusResult['shippingStatus'];
  }>;
}

function loadFixture(): ToolEvaluationFixture {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'eval/tool-cases.json'), 'utf8'),
  ) as ToolEvaluationFixture;
}

function seedSession(db: Database.Database, id: string, userIdent: string): void {
  const now = '2026-08-12T00:00:00.000Z';
  db.prepare(
    `INSERT INTO sessions (id, user_ident, status, created_at, updated_at, origin)
     VALUES (?, ?, 'active', ?, ?, 'customer')`,
  ).run(id, userIdent, now, now);
}

function createService(
  db: Database.Database,
  adapter: OrderStatusAdapter,
  options: { now?: () => Date; timeoutMs?: number; grantTtlMs?: number } = {},
): OrderToolService {
  return new OrderToolService(db, {
    adapter,
    secret: 'v0.3.5-tool-evaluation-secret',
    timeoutMs: options.timeoutMs ?? 50,
    grantTtlMs: options.grantTtlMs ?? 600_000,
    now: options.now,
  });
}

function assertNoPersistenceLeak(
  db: Database.Database,
  forbidden: string[],
): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  const persisted = JSON.stringify(tables.flatMap(({ name }) => (
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
  )));
  for (const secret of forbidden) {
    assert.equal(persisted.includes(secret), false, `persisted leak: ${secret}`);
  }
}

async function evaluateRoutes(fixture: ToolEvaluationFixture): Promise<{
  matches: number;
  writeActionLookupCalls: number;
}> {
  let matches = 0;
  let writeActionLookupCalls = 0;
  for (const testCase of fixture.routeCases) {
    const route = planOrderToolRoute(testCase.text);
    if (testCase.expectedKind === 'write_action' && route.kind === 'lookup') {
      writeActionLookupCalls += 1;
    }
    assert.equal(route.kind, testCase.expectedKind, testCase.id);
    if (route.orderReference) {
      assert.equal(route.safeMessage.includes(route.orderReference), false, `${testCase.id} redaction`);
    }
    matches += 1;
  }
  return { matches, writeActionLookupCalls };
}

async function evaluateDemoStates(fixture: ToolEvaluationFixture): Promise<number> {
  const adapter = new DemoOrderStatusAdapter();
  let matches = 0;
  for (const testCase of fixture.demoCases) {
    assert.equal(
      await adapter.verify(testCase.orderReference, testCase.verificationCode),
      true,
      `${testCase.orderReference} verification`,
    );
    const result = await adapter.lookup(
      testCase.orderReference,
      Date.now() + 1_000,
    ) as OrderStatusResult;
    assert.equal(result.orderStatus, testCase.expectedOrderStatus);
    assert.equal(result.shippingStatus, testCase.expectedShippingStatus);
    matches += 1;
  }
  return matches;
}

async function evaluateAuthorizationAndPrivacy(): Promise<{
  unauthorizedLookupCalls: number;
  leakCount: number;
}> {
  const db = new Database(':memory:');
  initSchema(db);
  seedSession(db, 'session-a', 'browser-a');
  seedSession(db, 'session-b', 'browser-b');

  const demo = new DemoOrderStatusAdapter();
  let lookupCalls = 0;
  const adapter: OrderStatusAdapter = {
    name: demo.name,
    version: demo.version,
    verify: (orderReference, verificationCode) => demo.verify(orderReference, verificationCode),
    async lookup(orderReference, deadline) {
      lookupCalls += 1;
      return demo.lookup(orderReference, deadline);
    },
  };
  let nowMs = Date.parse('2026-08-12T00:00:00.000Z');
  const service = createService(db, adapter, {
    now: () => new Date(nowMs),
    grantTtlMs: 600_000,
  });

  await assert.rejects(
    () => service.verify({
      sessionId: 'session-a',
      userIdent: 'browser-a',
      orderReference: 'RW-DEMO-1002',
      verificationCode: '000000',
    }),
    /订单号或验证码无效/,
  );
  assert.equal(lookupCalls, 0, 'wrong verification must not call lookup');

  const issued = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  assert.equal(service.resolveGrant(issued.token, {
    sessionId: 'session-b',
    userIdent: 'browser-b',
  }), null, 'cross-session grant');
  assert.equal(service.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'another-browser',
  }), null, 'cross-browser grant');
  assert.equal(lookupCalls, 0, 'unauthorized bindings must not call lookup');

  nowMs += 600_001;
  assert.equal(service.resolveGrant(issued.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  }), null, 'expired grant');
  assert.equal(lookupCalls, 0, 'expired grants must not call lookup');

  const active = await service.verify({
    sessionId: 'session-a',
    userIdent: 'browser-a',
    orderReference: 'RW-DEMO-1002',
    verificationCode: '135790',
  });
  const grant = service.resolveGrant(active.token, {
    sessionId: 'session-a',
    userIdent: 'browser-a',
  });
  assert.ok(grant);
  const response = await service.lookup(grant, 'tool-eval-valid-lookup');
  assert.equal(response.result.shippingStatus, 'in_transit');
  assert.equal(lookupCalls, 1, 'authorized lookup must call adapter exactly once');

  const persisted = JSON.stringify(db.prepare('SELECT * FROM messages').all());
  assert.equal(persisted.includes('运输中'), false, 'full result must not persist in history');
  assert.equal(persisted.includes('In transit'), false, 'English full result must not persist');
  assertNoPersistenceLeak(db, [
    'RW-DEMO-1002',
    '135790',
    issued.token,
    active.token,
  ]);
  db.close();
  return {
    unauthorizedLookupCalls: 0,
    leakCount: 0,
  };
}

async function evaluateFailurePolicies(): Promise<{
  timeoutCalls: number;
  unsafeResultDisplays: number;
  unsafeEscalations: number;
}> {
  const timeoutDb = new Database(':memory:');
  initSchema(timeoutDb);
  seedSession(timeoutDb, 'timeout-session', 'timeout-browser');
  let timeoutCalls = 0;
  const demo = new DemoOrderStatusAdapter();
  const timeoutService = createService(timeoutDb, {
    name: demo.name,
    version: demo.version,
    verify: (orderReference, verificationCode) => demo.verify(orderReference, verificationCode),
    async lookup(orderReference, deadline) {
      timeoutCalls += 1;
      return demo.lookup(orderReference, deadline);
    },
  }, { timeoutMs: 5 });
  const timeoutIssued = await timeoutService.verify({
    sessionId: 'timeout-session',
    userIdent: 'timeout-browser',
    orderReference: DEMO_TIMEOUT_ORDER.orderReference,
    verificationCode: DEMO_TIMEOUT_ORDER.verificationCode,
  });
  const timeoutGrant = timeoutService.resolveGrant(timeoutIssued.token, {
    sessionId: 'timeout-session',
    userIdent: 'timeout-browser',
  });
  assert.ok(timeoutGrant);
  await assert.rejects(
    () => timeoutService.lookup(timeoutGrant, 'tool-eval-timeout'),
    /unavailable/i,
  );
  assert.equal(timeoutCalls, 1);
  assert.equal(
    (timeoutDb.prepare('SELECT COUNT(*) AS count FROM escalation_log').get() as { count: number }).count,
    0,
    'timeout must not auto-escalate',
  );
  timeoutDb.close();

  const unsafeDb = new Database(':memory:');
  initSchema(unsafeDb);
  seedSession(unsafeDb, 'unsafe-session', 'unsafe-browser');
  const unsafeService = createService(unsafeDb, demo);
  const unsafeIssued = await unsafeService.verify({
    sessionId: 'unsafe-session',
    userIdent: 'unsafe-browser',
    orderReference: DEMO_INVALID_ORDER.orderReference,
    verificationCode: DEMO_INVALID_ORDER.verificationCode,
  });
  const unsafeGrant = unsafeService.resolveGrant(unsafeIssued.token, {
    sessionId: 'unsafe-session',
    userIdent: 'unsafe-browser',
  });
  assert.ok(unsafeGrant);
  await assert.rejects(
    () => unsafeService.lookup(unsafeGrant, 'tool-eval-unsafe'),
    /could not be verified/i,
  );
  const unsafeResultDisplays = (unsafeDb
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'")
    .get() as { count: number }).count;
  const unsafeEscalations = (unsafeDb
    .prepare(
      "SELECT COUNT(*) AS count FROM escalation_packets WHERE recommended_queue = 'order_support'",
    )
    .get() as { count: number }).count;
  assert.equal(unsafeResultDisplays, 0, 'unsafe provider result must not create assistant output');
  assert.equal(unsafeEscalations, 1, 'unsafe provider result must create order_support handoff');
  assertNoPersistenceLeak(unsafeDb, ['SUPPLIER-RAW-SECRET', 'Untrusted Carrier Inc.']);
  unsafeDb.close();

  return { timeoutCalls, unsafeResultDisplays, unsafeEscalations };
}

async function main(): Promise<void> {
  const fixture = loadFixture();
  const routeMatches = await evaluateRoutes(fixture);
  const demoMatches = await evaluateDemoStates(fixture);
  const authorization = await evaluateAuthorizationAndPrivacy();
  const failures = await evaluateFailurePolicies();

  console.log(`Tool evaluation ${fixture.version}`);
  console.log(`Route accuracy: ${routeMatches.matches}/${fixture.routeCases.length}`);
  console.log(`Demo states: ${demoMatches}/${fixture.demoCases.length}`);
  console.log(`Unauthorized lookup calls: ${authorization.unauthorizedLookupCalls}`);
  console.log(`Write-action lookup calls: ${routeMatches.writeActionLookupCalls}`);
  console.log(`Persistence leaks: ${authorization.leakCount}`);
  console.log(`Timeout adapter calls: ${failures.timeoutCalls}`);
  console.log(`Unsafe result displays: ${failures.unsafeResultDisplays}`);
  console.log(`Unsafe order_support escalations: ${failures.unsafeEscalations}`);
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
