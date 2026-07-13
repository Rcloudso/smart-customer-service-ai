import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import jwt from 'jsonwebtoken';

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

  test('document upload is private, searchable, paginated and lifecycle-safe', async ({ request }) => {
    const unauthenticated = await request.get('/api/admin/documents');
    expect(unauthenticated.status()).toBe(401);

    const token = await login(request);
    const headers = authHeaders(token);
    const invalidPageSize = await request.get('/api/admin/documents', {
      headers,
      params: { pageSize: 101 },
    });
    expect(invalidPageSize.status()).toBe(400);

    const fileName = `refund-policy-${Date.now()}.md`;
    const content = [
      '# 退款到账时间',
      '',
      '银杏计划退款将在审核通过后的三个工作日内到账。',
      '银行卡到账速度可能受发卡行处理时间影响。',
    ].join('\n');
    const upload = await request.post('/api/admin/documents', {
      headers,
      multipart: {
        file: {
          name: fileName,
          mimeType: 'text/markdown',
          buffer: Buffer.from(content),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const document = (await readJson(upload)).data;
    expect(document).toMatchObject({ fileName, format: 'md', status: 'ready', isActive: 1 });
    expect(document.chunkCount).toBeGreaterThan(0);
    expect(document).not.toHaveProperty('storagePath');
    expect(document).not.toHaveProperty('sha256');

    const list = await request.get('/api/admin/documents', {
      headers,
      params: { status: 'ready', isActive: true, keyword: 'refund-policy', page: 1, pageSize: 10 },
    });
    expect(list.status()).toBe(200);
    expect((await readJson(list)).data.items[0].id).toBe(document.id);

    const chunks = await request.get(`/api/admin/documents/${document.id}/chunks`, {
      headers,
      params: { page: 1, pageSize: 10 },
    });
    expect(chunks.status()).toBe(200);
    const chunkData = (await readJson(chunks)).data;
    expect(chunkData.total).toBeGreaterThan(0);
    expect(chunkData.items[0].content).toContain('三个工作日');
    expect(chunkData.items[0]).not.toHaveProperty('embedding');

    const duplicate = await request.post('/api/admin/documents', {
      headers,
      multipart: {
        file: {
          name: `same-content-${Date.now()}.md`,
          mimeType: 'text/markdown',
          buffer: Buffer.from(content),
        },
      },
    });
    expect(duplicate.status()).toBe(409);

    const invalidUpdate = await request.put(`/api/admin/documents/${document.id}`, {
      headers,
      data: { isActive: false, fileName: 'not-allowed.md' },
    });
    expect(invalidUpdate.status()).toBe(400);

    const chat = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: '银杏计划退款将在审核通过后的三个工作日内到账。', userIdent: `document-user-${Date.now()}` },
    });
    expect(chat.status()).toBe(200);
    const events = await parseSse(chat);
    const faqEvent = events.find((event) => event.type === 'faq');
    expect(faqEvent?.content ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ question: expect.stringContaining(fileName) }),
    ]));
    const tokenText = events
      .filter((event) => event.type === 'token')
      .map((event) => event.content)
      .join('');
    expect(tokenText).toContain(fileName);
    expect(tokenText).toContain('三个工作日');
    expect(events.find((event) => event.type === 'done').content).toMatchObject({
      sessionId: expect.any(String),
      messageId: expect.any(String),
    });
    const done = events.find((event) => event.type === 'done').content;
    const rating = await request.post('/api/chat/satisfaction', {
      data: { messageId: done.messageId, sessionId: done.sessionId, rating: 1 },
    });
    expect(rating.status()).toBe(200);
    const reviews = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { keyword: '银杏计划退款', page: 1, pageSize: 10 },
    });
    const documentSnapshot = (await readJson(reviews)).data.items[0].retrievalSnapshot
      .find((item: { knowledgeType: string }) => item.knowledgeType === 'document');
    expect(documentSnapshot).toMatchObject({
      knowledgeType: 'document',
      documentId: document.id,
      knowledgeId: expect.any(String),
      chunkIndex: expect.any(Number),
    });

    const deactivate = await request.put(`/api/admin/documents/${document.id}`, {
      headers,
      data: { isActive: false },
    });
    expect(deactivate.status()).toBe(200);
    expect((await readJson(deactivate)).data.isActive).toBe(0);

    const activate = await request.put(`/api/admin/documents/${document.id}`, {
      headers,
      data: { isActive: true },
    });
    expect(activate.status()).toBe(200);
    expect((await readJson(activate)).data.isActive).toBe(1);

    const deleted = await request.delete(`/api/admin/documents/${document.id}`, { headers });
    expect(deleted.status()).toBe(200);
    const missing = await request.get(`/api/admin/documents/${document.id}`, { headers });
    expect(missing.status()).toBe(404);
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

    const token = await login(request);
    const positiveReviewList = await request.get('/api/admin/knowledge-reviews', {
      headers: authHeaders(token),
      params: { keyword: question },
    });
    expect((await readJson(positiveReviewList)).data.total).toBe(0);
  });

  test('knowledge review closes the low-confidence feedback loop without duplicate FAQs', async ({ request }) => {
    const token = await login(request);
    const headers = authHeaders(token);

    const unauthenticated = await request.get('/api/admin/knowledge-reviews');
    expect(unauthenticated.status()).toBe(401);
    const nonAdminToken = jwt.sign(
      { id: 'viewer-id', username: 'viewer', role: 'viewer' },
      'test-secret-123',
    );
    const forbidden = await request.get('/api/admin/knowledge-reviews', {
      headers: authHeaders(nonAdminToken),
    });
    expect(forbidden.status()).toBe(403);
    const invalidPageSize = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { pageSize: 101 },
    });
    expect(invalidPageSize.status()).toBe(400);

    const matchedQuestion = '订单发货后多久能收到？';
    const matchedChat = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: matchedQuestion, userIdent: `negative-match-${Date.now()}` },
    });
    const matchedDone = (await parseSse(matchedChat)).find((event) => event.type === 'done').content;
    const messageOnlyRating = await request.post('/api/chat/satisfaction', {
      data: { messageId: matchedDone.messageId, rating: 1 },
    });
    expect(messageOnlyRating.status()).toBe(200);
    expect((await readJson(messageOnlyRating)).data).toMatchObject({
      messageId: matchedDone.messageId,
      sessionId: matchedDone.sessionId,
      rating: 1,
    });
    const matchedRating = await request.post('/api/chat/satisfaction', {
      data: { messageId: matchedDone.messageId, sessionId: matchedDone.sessionId, rating: 1 },
    });
    expect(matchedRating.status()).toBe(200);
    const matchedReview = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { triggerReason: 'negative_feedback', keyword: matchedQuestion },
    });
    const matchedReviewData = (await readJson(matchedReview)).data;
    const matchedReviewItem = matchedReviewData.items.find(
      (item: { assistantMessageId: string }) => item.assistantMessageId === matchedDone.messageId,
    );
    expect(matchedReviewItem).toBeDefined();
    expect(matchedReviewItem.retrievalSnapshot.length).toBeGreaterThan(0);

    const question = `qqqqqqqqqqqqqqqq-api-${Date.now()}`;
    const chatResponse = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: question, userIdent: `knowledge-user-${Date.now()}` },
    });
    const events = await parseSse(chatResponse);
    const done = events.find((event) => event.type === 'done').content;

    const pendingResponse = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { status: 'pending', keyword: question, page: 1, pageSize: 10 },
    });
    expect(pendingResponse.status()).toBe(200);
    const pendingData = (await readJson(pendingResponse)).data;
    expect(pendingData.total).toBe(1);
    expect(pendingData.items[0]).toMatchObject({
      question,
      status: 'pending',
      triggerReason: expect.stringMatching(/no_match|low_retrieval_score/),
    });
    expect(pendingData.items[0].retrievalSnapshot.length).toBeLessThanOrEqual(3);

    const mismatchRating = await request.post('/api/chat/satisfaction', {
      data: { messageId: done.messageId, sessionId: 'not-the-message-session', rating: 1 },
    });
    expect(mismatchRating.status()).toBe(400);

    const lowRating = await request.post('/api/chat/satisfaction', {
      data: { messageId: done.messageId, sessionId: done.sessionId, rating: 1 },
    });
    expect(lowRating.status()).toBe(200);
    const ratedList = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { keyword: question },
    });
    const ratedData = (await readJson(ratedList)).data;
    expect(ratedData.total).toBe(1);
    expect(ratedData.items[0]).toMatchObject({ triggerReason: 'negative_feedback', rating: 1 });

    const convertResponse = await request.post(`/api/admin/knowledge-reviews/${ratedData.items[0].id}/convert`, {
      headers,
      data: {
        question,
        answer: '这是从知识审核闭环沉淀的答案',
        category: 'general',
        keywords: ['knowledge-loop'],
      },
    });
    expect(convertResponse.status()).toBe(200);
    const converted = (await readJson(convertResponse)).data;
    expect(converted.review.status).toBe('converted');
    expect(converted.review.linkedFaqId).toBe(converted.faq.id);

    const retryResponse = await request.post(`/api/admin/knowledge-reviews/${ratedData.items[0].id}/convert`, {
      headers,
      data: {
        question: 'retry must not replace the FAQ',
        answer: 'retry must not replace the FAQ',
        category: 'general',
        keywords: [],
      },
    });
    expect(retryResponse.status()).toBe(200);
    expect((await readJson(retryResponse)).data.faq.id).toBe(converted.faq.id);

    const searchResponse = await request.get('/api/faq/search', { params: { q: question } });
    expect(searchResponse.status()).toBe(200);
    expect((await readJson(searchResponse)).data[0]).toMatchObject({
      id: converted.faq.id,
      answer: '这是从知识审核闭环沉淀的答案',
    });

    const dismissConverted = await request.post(`/api/admin/knowledge-reviews/${ratedData.items[0].id}/dismiss`, {
      headers,
      data: { reason: 'too late' },
    });
    expect(dismissConverted.status()).toBe(409);

    const specialQuestion = '%_%%%%____';
    const specialChat = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: specialQuestion, userIdent: `special-filter-${Date.now()}` },
    });
    const specialDone = (await parseSse(specialChat)).find((event) => event.type === 'done').content;
    await request.post('/api/chat/satisfaction', {
      data: { messageId: specialDone.messageId, sessionId: specialDone.sessionId, rating: 1 },
    });
    const specialFilter = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { triggerReason: 'negative_feedback', keyword: '%_', page: 1, pageSize: 1 },
    });
    const specialFilterData = (await readJson(specialFilter)).data;
    expect(specialFilterData.items).toHaveLength(1);
    expect(specialFilterData.items[0].question).toBe(specialQuestion);
    expect(specialFilterData.pageSize).toBe(1);

    const secondPage = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { triggerReason: 'negative_feedback', page: 2, pageSize: 1 },
    });
    expect((await readJson(secondPage)).data.items).toHaveLength(1);

    const explicitQuestion = `转人工客服 ${Date.now()}`;
    const explicitResponse = await request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: explicitQuestion, userIdent: `explicit-user-${Date.now()}` },
    });
    const explicitEvents = await parseSse(explicitResponse);
    expect(explicitEvents.some((event) => event.type === 'escalate')).toBe(true);
    const explicitDone = explicitEvents.find((event) => event.type === 'done').content;
    const explicitConversation = await request.get(`/api/admin/conversations/${explicitDone.sessionId}`, { headers });
    expect((await readJson(explicitConversation)).data.escalation).toMatchObject({ status: 'pending' });
    const explicitList = await request.get('/api/admin/knowledge-reviews', {
      headers,
      params: { keyword: explicitQuestion },
    });
    expect((await readJson(explicitList)).data.total).toBe(0);

    const statsResponse = await request.get('/api/admin/knowledge-reviews/stats', { headers });
    expect(statsResponse.status()).toBe(200);
    expect((await readJson(statsResponse)).data).toMatchObject({
      converted: expect.any(Number),
      total: expect.any(Number),
    });
  });
});
