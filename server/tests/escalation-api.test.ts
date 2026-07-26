import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { IntentCategory, MessageRole } from '../types/domain';

const dbPath = path.resolve(process.cwd(), 'data/escalation-api-test.db');

async function main(): Promise<void> {
  fs.rmSync(dbPath, { force: true });
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-123';
  process.env.DB_PATH = dbPath;
  process.env.LLM_API_KEY = '';
  process.env.OPENAI_API_KEY = '';

  const [
    { default: escalationRouter },
    { errorHandler },
    { conversationService },
    databaseModule,
  ] = await Promise.all([
    import('../routes/admin/escalations'),
    import('../middleware/errorHandler'),
    import('../services/conversation.service'),
    import('../db'),
  ]);

  const session = conversationService.createSession('api-triage-user');
  const userMessage = conversationService.saveMessage({
    sessionId: session.id,
    role: MessageRole.USER,
    content: '订单 API_100% 一直没有发货，请转人工',
  });
  const assistant = await conversationService.saveMessageAndEscalate({
    sessionId: session.id,
    role: MessageRole.ASSISTANT,
    content: '已为你转接人工客服',
    intent: IntentCategory.ORDER,
    replyToMessageId: userMessage.id,
    groundingStatus: 'high_risk',
  }, '当前请求涉及尚未授权的业务操作，需要人工处理');

  const db = databaseModule.getDatabase();
  const escalationId = (
    db.prepare('SELECT id FROM escalation_log WHERE session_id = ?').get(session.id) as { id: string }
  ).id;
  assert.equal(assistant.escalated, 1);

  const app = express();
  app.use(express.json());
  app.use('/api/admin/escalations', escalationRouter);
  app.use(errorHandler);
  let server: Server | null = null;
  try {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/admin/escalations`;
    const token = jwt.sign(
      { id: 'admin-id', username: 'admin', role: 'admin' },
      'test-secret-123',
      { expiresIn: '1h' },
    );

    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 401);

    const list = await fetch(`${url}?status=pending&queue=order_support&keyword=${encodeURIComponent('API_100%')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(list.status, 200);
    const listBody = await list.json() as {
      code: number;
      data: { total: number; items: Array<{ id: string; packet: { priority: string } }> };
    };
    assert.equal(listBody.code, 0);
    assert.equal(listBody.data.total, 1);
    assert.equal(listBody.data.items[0].id, escalationId);
    assert.equal(listBody.data.items[0].packet.priority, 'high');

    const detail = await fetch(`${url}/${escalationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as {
      data: {
        packet: { escalationId: string };
        referencedMessageIds: string[];
        messages: Array<{ id: string }>;
      };
    };
    assert.equal(detailBody.data.packet.escalationId, escalationId);
    assert.ok(detailBody.data.referencedMessageIds.includes(userMessage.id));
    assert.ok(detailBody.data.messages.some((message) => message.id === userMessage.id));

    const invalidPage = await fetch(`${url}?pageSize=101`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(invalidPage.status, 400);

    const missing = await fetch(`${url}/00000000-0000-4000-8000-000000000000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    }
    databaseModule.closeDatabase();
    fs.rmSync(dbPath, { force: true });
  }

  console.log('Escalation API tests passed');
}

void main();
