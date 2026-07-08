import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

async function readJson(response: APIResponse): Promise<any> {
  return response.json();
}

async function login(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin123' },
  });
  expect(response.status()).toBe(200);
  const body = await readJson(response);
  expect(body.code).toBe(0);
  expect(body.data.token).toEqual(expect.any(String));
  return body.data.token;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function parseSse(response: APIResponse): Promise<any[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

test.describe('API automation: boundaries and exception flows', () => {
  test('health check returns stable envelope', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      code: 0,
      message: 'ok',
      data: { status: 'ok' },
    });
    expect(body.data.uptime).toEqual(expect.any(Number));
  });

  test('login accepts valid credentials and rejects missing/wrong credentials', async ({ request }) => {
    const token = await login(request);
    expect(token.length).toBeGreaterThan(20);

    const emptyResponse = await request.post('/api/auth/login', {
      data: { username: '', password: '' },
    });
    expect(emptyResponse.status()).toBe(400);
    expect((await readJson(emptyResponse)).message).toContain('用户名不能为空');

    const wrongResponse = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'wrong-password' },
    });
    expect(wrongResponse.status()).toBe(401);
    expect((await readJson(wrongResponse)).message).toBe('用户名或密码错误');
  });

  test('admin FAQ endpoints require auth and validate boundary fields', async ({ request }) => {
    const unauthenticated = await request.get('/api/admin/faq/index/status');
    expect(unauthenticated.status()).toBe(401);

    const unauthenticatedDebug = await request.post('/api/admin/faq/search/debug', {
      data: { query: '退款' },
    });
    expect(unauthenticatedDebug.status()).toBe(401);

    const invalidToken = await request.get('/api/admin/faq/index/status', {
      headers: authHeaders('not-a-token'),
    });
    expect(invalidToken.status()).toBe(401);

    const token = await login(request);
    const invalidCreate = await request.post('/api/admin/faq', {
      headers: authHeaders(token),
      data: { question: '', answer: '', category: 'not-real', keywords: [] },
    });
    expect(invalidCreate.status()).toBe(400);
    const invalidBody = await readJson(invalidCreate);
    expect(invalidBody.message).toContain('问题不能为空');

    const invalidActive = await request.post('/api/admin/faq', {
      headers: authHeaders(token),
      data: { question: 'bad active', answer: 'bad active', category: 'general', keywords: [], isActive: 2 },
    });
    expect(invalidActive.status()).toBe(400);
  });

  test('admin FAQ debug search requires valid input and returns ranked explanations', async ({ request }) => {
    const token = await login(request);

    const invalidDebug = await request.post('/api/admin/faq/search/debug', {
      headers: authHeaders(token),
      data: { query: '', topK: 5 },
    });
    expect(invalidDebug.status()).toBe(400);

    const debugResponse = await request.post('/api/admin/faq/search/debug', {
      headers: authHeaders(token),
      data: { query: '如何申请退款？', topK: 3 },
    });
    expect(debugResponse.status()).toBe(200);
    const debugBody = (await readJson(debugResponse)).data;
    expect(debugBody).toMatchObject({
      query: '如何申请退款？',
      topK: 3,
      indexStatus: {
        initialized: true,
      },
    });
    expect(debugBody.matches[0]).toMatchObject({
      rank: 1,
      question: '如何申请退款？',
      source: expect.stringMatching(/keyword|vector|hybrid/),
      bestScore: expect.any(Number),
      rankingReason: expect.any(String),
    });
    expect(debugBody.matches[0].matchedBy.length).toBeGreaterThan(0);
  });

  test('FAQ CRUD, index rebuild, exact search, wildcard escaping and invalid limits', async ({ request }) => {
    const token = await login(request);
    const unique = `E2E FAQ ${Date.now()}`;
    const answer = 'E2E exact answer for automated API test';

    const createResponse = await request.post('/api/admin/faq', {
      headers: authHeaders(token),
      data: {
        question: unique,
        answer,
        category: 'general',
        keywords: ['E2E', '边界', '%_wildcard'],
      },
    });
    expect(createResponse.status()).toBe(201);
    const created = (await readJson(createResponse)).data;
    expect(created.question).toBe(unique);

    const rebuildResponse = await request.post('/api/admin/faq/index/rebuild', {
      headers: authHeaders(token),
      data: {},
    });
    expect(rebuildResponse.status()).toBe(200);
    expect((await readJson(rebuildResponse)).data.indexedCount).toBeGreaterThan(0);

    const exactSearch = await request.get('/api/faq/search', {
      params: { q: unique, limit: 5 },
    });
    expect(exactSearch.status()).toBe(200);
    const exactItems = (await readJson(exactSearch)).data;
    expect(exactItems[0]).toMatchObject({
      id: created.id,
      question: unique,
      answer,
      source: expect.stringMatching(/keyword|hybrid/),
      keywordScore: expect.any(Number),
    });

    const wildcardSearch = await request.get('/api/faq/search', {
      params: { q: '%_wildcard', limit: 5 },
    });
    expect(wildcardSearch.status()).toBe(200);
    const wildcardItems = (await readJson(wildcardSearch)).data;
    expect(wildcardItems.some((item: any) => item.id === created.id)).toBe(true);

    const emptyQuery = await request.get('/api/faq/search', {
      params: { q: '', limit: 5 },
    });
    expect(emptyQuery.status()).toBe(400);

    const tooLargeLimit = await request.get('/api/faq/search', {
      params: { q: unique, limit: 21 },
    });
    expect(tooLargeLimit.status()).toBe(400);

    const updateResponse = await request.put(`/api/admin/faq/${created.id}`, {
      headers: authHeaders(token),
      data: { answer: `${answer} updated`, keywords: ['E2E-updated'] },
    });
    expect(updateResponse.status()).toBe(200);
    expect((await readJson(updateResponse)).data.answer).toContain('updated');

    const deleteResponse = await request.delete(`/api/admin/faq/${created.id}`, {
      headers: authHeaders(token),
    });
    expect(deleteResponse.status()).toBe(200);
  });

  test('chat SSE validates input boundaries, returns direct FAQ answer, and enforces history ownership', async ({ request }) => {
    const question = '如何申请退款？';
    const userIdent = `api-user-${Date.now()}`;

    const emptyMessage = await request.post('/api/chat', {
      data: { message: '', userIdent },
    });
    expect(emptyMessage.status()).toBe(400);

    const tooLongMessage = await request.post('/api/chat', {
      data: { message: 'x'.repeat(2001), userIdent },
    });
    expect(tooLongMessage.status()).toBe(400);

    const chatResponse = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: question, userIdent },
    });
    expect(chatResponse.status()).toBe(200);
    const events = await parseSse(chatResponse);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['intent', 'faq', 'token', 'done']));
    const faqEvent = events.find((event) => event.type === 'faq');
    expect(faqEvent.content[0]).toMatchObject({
      question,
      source: expect.stringMatching(/keyword|hybrid/),
    });
    const tokenText = events
      .filter((event) => event.type === 'token')
      .map((event) => event.content)
      .join('');
    expect(tokenText).toContain('登录您的账户');
    const doneEvent = events.find((event) => event.type === 'done');
    expect(doneEvent.content.sessionId).toEqual(expect.any(String));

    const badRatingLow = await request.post('/api/chat/satisfaction', {
      data: { sessionId: doneEvent.content.sessionId, rating: 0 },
    });
    expect(badRatingLow.status()).toBe(400);

    const badRatingHigh = await request.post('/api/chat/satisfaction', {
      data: { sessionId: doneEvent.content.sessionId, rating: 6 },
    });
    expect(badRatingHigh.status()).toBe(400);

    const ratingResponse = await request.post('/api/chat/satisfaction', {
      data: { sessionId: doneEvent.content.sessionId, rating: 5 },
    });
    expect(ratingResponse.status()).toBe(200);

    const historyResponse = await request.get('/api/chat/sessions', {
      params: { userIdent, page: 1, pageSize: 5 },
    });
    expect(historyResponse.status()).toBe(200);
    const history = (await readJson(historyResponse)).data;
    expect(history.items[0]).toMatchObject({
      id: doneEvent.content.sessionId,
      preview: question,
      messageCount: 2,
    });

    const detailResponse = await request.get(`/api/chat/sessions/${doneEvent.content.sessionId}`, {
      params: { userIdent },
    });
    expect(detailResponse.status()).toBe(200);
    expect((await readJson(detailResponse)).data.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);

    const wrongOwnerResponse = await request.get(`/api/chat/sessions/${doneEvent.content.sessionId}`, {
      params: { userIdent: 'somebody-else' },
    });
    expect(wrongOwnerResponse.status()).toBe(404);
  });
});
