import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function clearBrowserState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-username').locator('input').fill('admin');
  await page.getByTestId('login-password').locator('input').fill('admin123');
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/auth/login')),
    page.getByRole('button', { name: '登录' }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/admin$/);
}

function knowledgeReviewRow(page: Page, question: string) {
  return page.getByTestId('knowledge-review-table').locator('tr').filter({ hasText: question });
}

function documentRow(page: Page, fileName: string) {
  return page.getByTestId('documents-page').locator('tr').filter({ hasText: fileName });
}

test.describe('Web automation: customer chat experience', () => {
  test.beforeEach(async ({ page }) => {
    await clearBrowserState(page);
  });

  test('chat supports FAQ answers, left-side history, new chat and history restore', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('chat-layout')).toBeVisible();
    await expect(page.getByTestId('chat-sidebar')).toBeVisible();
    await expect(page.getByTestId('new-chat-button')).toContainText('新对话');
    await expect(page.getByRole('button', { name: '清空对话' })).toHaveCount(0);

    const input = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('chat-send-button');
    await expect(sendButton).toHaveClass(/t-is-disabled/);

    await input.fill('如何申请退款？');
    await expect(sendButton).not.toHaveClass(/t-is-disabled/);
    await sendButton.click();

    await expect(page.getByTestId('chat-messages')).toContainText('如何申请退款？');
    await expect(page.getByTestId('chat-messages')).toContainText('登录您的账户', { timeout: 15_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('相关FAQ参考');
    await expect(page.getByTestId('chat-grounding-status')).toContainText('FAQ 原文');
    await expect(page.getByTestId('chat-grounding-status')).toContainText('检索阈值已满足');
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.7-grounding-citations.png',
        fullPage: true,
      });
    }

    const historyItem = page.getByTestId('chat-history-item').filter({ hasText: '如何申请退款？' }).first();
    await expect(historyItem).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('new-chat-button').click();
    await expect(page.getByTestId('chat-messages')).toContainText('您好，有什么可以帮您？');
    await expect(page.getByTestId('chat-messages')).not.toContainText('登录您的账户');

    await historyItem.click();
    await expect(page.getByTestId('chat-messages')).toContainText('如何申请退款？');
    await expect(page.getByTestId('chat-messages')).toContainText('登录您的账户');
    await expect(page.getByTestId('chat-faq-references')).toContainText('如何申请退款？');
    await expect(page.getByTestId('chat-grounding-status')).toContainText('FAQ 原文');
  });

  test('language and theme toggles update fixed copy and document theme', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'AI 智能客服' })).toBeVisible();
    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'AI Customer Service' })).toBeVisible();
    await expect(page.getByTestId('new-chat-button')).toContainText('New chat');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('assistant messages render safe Markdown without executing raw HTML', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      const events = [
        { type: 'intent', content: 'general', confidence: 0.9 },
        { type: 'token', content: '1. **薪酬制度**\\n2. <script>window.__unsafe = true</script>' },
        {
          type: 'done',
          content: {
            sessionId: 'markdown-session',
            messageId: 'markdown-message',
            intent: 'general',
            answerMode: 'grounded_generation',
            groundingStatus: 'sufficient',
            groundingReason: 'retrieval_supported',
            knowledgeSources: [{
              knowledgeType: 'document',
              knowledgeId: 'compensation-chunk',
              documentId: 'compensation-document',
              title: '公司薪酬制度.pdf',
              similarity: 0.63,
              source: 'vector',
              chunkIndex: 1,
              pageStart: 2,
              pageEnd: 2,
            }],
          },
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('介绍薪酬制度');
    await page.getByTestId('chat-send-button').click();

    const assistantBubble = page.locator('.app-chat-bubble--assistant').last();
    await expect(assistantBubble.locator('strong')).toHaveText('薪酬制度');
    await expect(assistantBubble).not.toContainText('**薪酬制度**');
    await expect(assistantBubble.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { __unsafe?: boolean }).__unsafe)).not.toBe(true);
    await expect(page.getByTestId('chat-document-references')).toContainText('公司薪酬制度.pdf');
    await expect(page.getByTestId('chat-document-references')).toContainText('切片 2');
    await expect(page.getByTestId('chat-document-references')).toContainText('第 2 页');
    const grounding = page.getByTestId('chat-grounding-status');
    await expect(grounding).toContainText('检索支持生成');
    await expect(grounding).toContainText('检索阈值已满足');
    await page.getByTestId('language-toggle').click();
    await expect(grounding).toContainText('Retrieval-supported');
    await expect(grounding).toContainText('Evidence threshold met');
  });

  test('a failed partial stream is not presented as a completed rateable answer', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      const events = [
        { type: 'intent', content: 'general', confidence: 0.9 },
        { type: 'token', content: '这是一段未完成的回答' },
        { type: 'error', content: 'AI响应生成失败，请稍后重试' },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('触发流式失败');
    await page.getByTestId('chat-send-button').click();

    const assistantBubble = page.locator('.app-chat-bubble--assistant').last();
    await expect(assistantBubble).toContainText('AI响应生成失败，请稍后重试');
    await expect(assistantBubble).not.toContainText('这是一段未完成的回答');
    await expect(page.locator('.app-chat-rating-row')).toHaveCount(0);
  });
});

test.describe('Web automation: admin boundaries and FAQ index operation', () => {
  test.beforeEach(async ({ page }) => {
    await clearBrowserState(page);
  });

  test('login rejects wrong password and accepts admin credentials', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => localStorage.setItem('auth_token', 'existing-token'));

    await page.getByTestId('login-username').locator('input').fill('admin');
    await page.getByTestId('login-password').locator('input').fill('wrong-password');
    const [wrongRequest, wrongResponse] = await Promise.all([
      page.waitForRequest((request) => request.url().includes('/api/auth/login')),
      page.waitForResponse((res) => res.url().includes('/api/auth/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);
    expect(wrongRequest.headers()['authorization']).toBeUndefined();
    expect(wrongResponse.status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('用户名或密码错误')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('auth_token'))).toBe('existing-token');

    await page.getByTestId('login-password').locator('input').fill('admin123');
    const [successResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);
    expect(successResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible();
  });

  test('dashboard date picker opens without crashing the page', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await loginAsAdmin(page);
    await page.getByPlaceholder('开始日期').click();
    await page.waitForTimeout(50);

    expect(consoleErrors.filter((message) => message.includes('DatePicker'))).toEqual([]);
    await expect(page.getByRole('heading', { name: '数据概览' })).toBeVisible();
  });

  test('model configuration shows environment credential status without key inputs', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('模型配置').click();
    await expect(page).toHaveURL(/\/admin\/config$/);

    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByTestId('llm-api-key-status')).toContainText('未配置');
    await expect(page.getByTestId('llm-api-key-status')).toContainText('LLM_API_KEY');
    await expect(page.getByTestId('embed-api-key-status')).toContainText('未配置');
    await expect(page.getByTestId('embed-api-key-status')).toContainText('EMBED_API_KEY');

    await page.getByTestId('language-toggle').click();
    await expect(page.getByTestId('llm-api-key-status')).toContainText('Not configured');
    await expect(page.getByTestId('llm-api-key-status')).toContainText('environment');
  });

  test('model provider selection echoes configured values and controls custom base URL fields', async ({ page }) => {
    let useOfficialProviders = false;
    await page.route('**/api/admin/config/model', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            llmProvider: useOfficialProviders ? 'openai' : 'openai-compatible',
            llmApiBase: 'https://compatible.example/v1',
            llmModel: 'compatible-chat',
            embedProvider: useOfficialProviders ? 'openai' : 'other',
            embedApiBase: 'http://localhost:11434/v1',
            embedModel: 'local-embedding',
            llmApiKeyConfigured: false,
            embedApiKeyConfigured: false,
          },
          message: 'ok',
        }),
      });
    });

    await loginAsAdmin(page);
    await page.getByText('模型配置').click();
    await expect(page.getByTestId('llm-provider-select').locator('input')).toHaveValue('OpenAI Compatible');
    await expect(page.getByTestId('embed-provider-select').locator('input')).toHaveValue('其他');
    await expect(page.getByTestId('llm-api-base-field')).toBeVisible();
    await expect(page.getByTestId('embed-api-base-field')).toBeVisible();

    useOfficialProviders = true;
    await page.getByTestId('language-toggle').click();
    await expect(page.getByTestId('llm-provider-select').locator('input')).toHaveValue('OpenAI');
    await expect(page.getByTestId('embed-provider-select').locator('input')).toHaveValue('OpenAI');
    await expect(page.getByTestId('llm-api-base-field')).toHaveCount(0);
    await expect(page.getByTestId('embed-api-base-field')).toHaveCount(0);
  });

  test('dashboard date filter resets to the unfiltered range', async ({ page }) => {
    const overviewRequests: string[] = [];
    const trendRequests: string[] = [];
    await page.route('**/api/admin/stats/overview**', async (route) => {
      overviewRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            totalConversations: 0,
            totalMessages: 0,
            avgSatisfaction: 0,
            escalationRate: 0,
            activeSessions: 0,
            intentDistribution: [],
          },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/stats/satisfaction-trend**', async (route) => {
      trendRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: [], message: 'ok' }),
      });
    });

    await loginAsAdmin(page);
    const startDateInput = page.getByPlaceholder('开始日期');
    const endDateInput = page.getByPlaceholder('结束日期');
    await expect.poll(() => overviewRequests.length).toBeGreaterThan(0);
    await expect.poll(() => trendRequests.length).toBeGreaterThan(0);
    await page.waitForTimeout(50);
    const initialOverviewCount = overviewRequests.length;
    const initialTrendCount = trendRequests.length;
    await startDateInput.fill('2026-07-01');
    await endDateInput.fill('2026-07-15');
    await endDateInput.press('Enter');
    await page.waitForTimeout(250);
    expect(overviewRequests).toHaveLength(initialOverviewCount);
    expect(trendRequests).toHaveLength(initialTrendCount);

    await page.getByTestId('dashboard-filter-search').click();
    await expect.poll(() => overviewRequests.some((requestUrl) => {
      const url = new URL(requestUrl);
      return url.searchParams.get('from') === '2026-07-01'
        && url.searchParams.get('to') === '2026-07-15';
    })).toBe(true);

    const overviewCount = overviewRequests.length;
    const trendCount = trendRequests.length;
    await page.getByTestId('dashboard-filter-reset').click();
    await expect.poll(() => overviewRequests.length).toBe(overviewCount + 1);
    await expect.poll(() => trendRequests.length).toBe(trendCount + 1);
    for (const requestUrl of [overviewRequests.at(-1)!, trendRequests.at(-1)!]) {
      const url = new URL(requestUrl);
      expect(url.searchParams.get('from')).toBeNull();
      expect(url.searchParams.get('to')).toBeNull();
    }
    await expect(startDateInput).toHaveValue('');
    await expect(endDateInput).toHaveValue('');
  });

  test('dashboard trend pagination reports rendered dates and explains the active window', async ({ page }) => {
    const trend = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, '0')}`,
      avgRating: index === 0 ? 5 : 0,
      count: index === 0 ? 2 : 0,
    }));
    await page.route('**/api/admin/stats/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            totalConversations: 20,
            totalMessages: 40,
            avgSatisfaction: 5,
            escalationRate: 0,
            activeSessions: 2,
            activeWindowMinutes: 30,
            intentDistribution: [],
          },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/stats/satisfaction-trend**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: trend, message: 'ok' }),
      });
    });

    await loginAsAdmin(page);
    await expect(page.getByText('近 30 分钟活跃')).toBeVisible();
    await expect(page.getByText(/共\s*20\s*条数据/)).toBeVisible();
    const trendRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(trendRows).toHaveCount(14);
    await expect(trendRows.first()).toContainText('2026-06-20');
  });

  test('an authenticated 401 clears local auth state and returns to login', async ({ page }) => {
    await loginAsAdmin(page);
    await expect.poll(() => page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      user: localStorage.getItem('auth_user'),
    }))).not.toEqual({ token: null, user: null });

    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);
    await expect(page.getByRole('heading', { name: /FAQ\s*管理/ })).toBeVisible();

    let requestAuthorization: string | undefined;
    await page.route('**/api/admin/stats/overview**', async (route) => {
      requestAuthorization = route.request().headers()['authorization'];
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, data: null, message: 'Invalid token' }),
      });
    });

    await page.locator('.app-admin-sidebar').getByText('数据概览').click();

    await expect(page).toHaveURL(/\/login$/);
    expect(requestAuthorization).toMatch(/^Bearer\s+\S+$/);
    await expect.poll(() => page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      user: localStorage.getItem('auth_user'),
    }))).toEqual({ token: null, user: null });
  });

  test('an authenticated 401 with malformed JSON still clears auth state', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);
    await expect(page.getByRole('heading', { name: /FAQ\s*管理/ })).toBeVisible();

    await page.route('**/api/admin/stats/overview**', async (route) => {
      expect(route.request().headers()['authorization']).toMatch(/^Bearer\s+\S+$/);
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{',
      });
    });

    await page.locator('.app-admin-sidebar').getByText('数据概览').click();

    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      user: localStorage.getItem('auth_user'),
    }))).toEqual({ token: null, user: null });
  });

  test('an authenticated export 401 clears auth state', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('对话管理').click();
    await expect(page).toHaveURL(/\/admin\/conversations$/);
    await expect(page.getByRole('heading', { name: '对话管理' })).toBeVisible();

    let requestAuthorization: string | undefined;
    await page.route('**/api/admin/conversations/export**', async (route) => {
      requestAuthorization = route.request().headers()['authorization'];
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, data: null, message: 'Invalid token' }),
      });
    });

    await page.getByRole('button', { name: '导出筛选对话' }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(requestAuthorization).toMatch(/^Bearer\s+\S+$/);
    await expect.poll(() => page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      user: localStorage.getItem('auth_user'),
    }))).toEqual({ token: null, user: null });
  });

  test('conversation filters reset to their defaults', async ({ page }) => {
    await loginAsAdmin(page);
    const listRequests: string[] = [];
    await page.route('**/api/admin/conversations?**', async (route) => {
      listRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });
    await page.getByText('对话管理').click();
    await expect(page).toHaveURL(/\/admin\/conversations$/);
    await expect.poll(() => listRequests.length).toBeGreaterThan(0);
    const initialRequestCount = listRequests.length;

    const keywordInput = page.getByPlaceholder('搜索关键词...');
    const statusInput = page.getByRole('textbox', { name: '会话状态' });
    const createdDateInput = page.getByPlaceholder('创建日期');
    await keywordInput.fill('refund-user');
    await statusInput.click();
    await page.getByText('已关闭', { exact: true }).last().click();
    await createdDateInput.click();
    await page
      .locator('.t-date-picker__panel .t-date-picker__cell:not(.t-date-picker__cell--additional) .t-date-picker__cell-inner')
      .filter({ hasText: /^17$/ })
      .click();
    await page.waitForTimeout(250);
    expect(listRequests).toHaveLength(initialRequestCount);

    await page.getByRole('button', { name: '查询' }).click();
    await expect.poll(() => listRequests.length).toBe(initialRequestCount + 1);
    const submittedUrl = new URL(listRequests.at(-1)!);
    expect(submittedUrl.searchParams.get('keyword')).toBe('refund-user');
    expect(submittedUrl.searchParams.get('status')).toBe('closed');
    expect(submittedUrl.searchParams.get('from')).toBe('2026-07-17');
    expect(submittedUrl.searchParams.get('to')).toBe('2026-07-17');
    expect(submittedUrl.searchParams.get('timezoneOffset')).not.toBeNull();
    expect(submittedUrl.searchParams.get('timezoneOffsetTo')).not.toBeNull();

    let exportUrl = '';
    await page.route('**/api/admin/conversations/export**', async (route) => {
      exportUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        body: 'SessionID,Content\nsession,filtered',
      });
    });
    await page.getByRole('button', { name: '导出筛选对话' }).click();
    await expect.poll(() => exportUrl).not.toBe('');
    const exported = new URL(exportUrl);
    expect(exported.searchParams.get('keyword')).toBe('refund-user');
    expect(exported.searchParams.get('status')).toBe('closed');
    expect(exported.searchParams.get('from')).toBe('2026-07-17');
    expect(exported.searchParams.get('to')).toBe('2026-07-17');
    expect(exported.searchParams.get('timezoneOffset')).toBe(
      submittedUrl.searchParams.get('timezoneOffset'),
    );
    expect(exported.searchParams.get('timezoneOffsetTo')).toBe(
      submittedUrl.searchParams.get('timezoneOffsetTo'),
    );

    const resetRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/api/admin/conversations')
        && !url.searchParams.has('keyword')
        && !url.searchParams.has('status')
        && !url.searchParams.has('from')
        && !url.searchParams.has('to');
    });
    await page.getByTestId('conversation-filter-reset').click();
    await resetRequestPromise;
    await expect(keywordInput).toHaveValue('');
    await expect(statusInput).toHaveValue('全部状态');
    await expect(createdDateInput).toHaveValue('');
  });

  test('admin conversation echoes render safe Markdown and knowledge actions share table styling', async ({ page }) => {
    const timestamp = '2026-07-18T12:00:00.000Z';
    const markdownAnswer = '**粗体回答**\n\n1. 第一项\n2. 第二项\n\n<script>window.__adminUnsafe = true</script>';
    await loginAsAdmin(page);

    await page.route('**/api/admin/conversations?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            items: [{
              id: 'markdown-session',
              userIdent: 'markdown-user',
              status: 'active',
              messageCount: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            }],
            total: 1,
            page: 1,
            pageSize: 20,
          },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/conversations/markdown-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            session: {
              id: 'markdown-session',
              userIdent: 'markdown-user',
              status: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
              closedAt: null,
              closeReason: null,
            },
            messages: [{
              id: 'markdown-message',
              role: 'assistant',
              content: markdownAnswer,
              intent: 'general',
              intentConf: 0.9,
              satisfaction: null,
              escalated: 0,
              createdAt: timestamp,
            }],
            escalation: null,
          },
          message: 'ok',
        }),
      });
    });

    await page.getByText('对话管理').click();
    await page.getByRole('button', { name: '查看详情' }).click();
    const conversationDetail = page.locator('.app-conversation-detail');
    await expect(conversationDetail.locator('strong')).toHaveText('粗体回答');
    await expect(conversationDetail.locator('ol li')).toHaveCount(2);
    await expect(conversationDetail.locator('script')).toHaveCount(0);
    await page.locator('.t-dialog:visible .t-dialog__close').click();
    await expect(conversationDetail).toBeHidden();

    const reviewItem = {
      id: 'markdown-review',
      sessionId: 'markdown-session',
      userMessageId: 'markdown-user-message',
      assistantMessageId: 'markdown-message',
      question: '**用户问题**',
      answer: markdownAnswer,
      intent: 'general',
      intentConf: 0.9,
      retrievalSnapshot: [],
      triggerReason: 'low_retrieval_score',
      rating: 2,
      status: 'pending',
      linkedFaqId: null,
      dismissReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await page.route('**/api/admin/knowledge-reviews/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { pending: 1, converted: 0, dismissed: 0, total: 1 },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/knowledge-reviews?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [reviewItem], total: 1, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });

    await page.getByText('知识审核').click();
    const reviewRow = knowledgeReviewRow(page, '用户问题');
    await expect(reviewRow.getByTestId('knowledge-review-view')).toHaveClass(/app-table-action-button/);
    await expect(reviewRow.getByTestId('knowledge-review-convert')).toHaveClass(/app-table-action-button/);
    await expect(reviewRow.getByTestId('knowledge-review-dismiss')).toHaveClass(/app-table-action-button/);
    await reviewRow.getByTestId('knowledge-review-view').click();
    const reviewDetail = page.getByTestId('knowledge-review-detail');
    await expect(reviewDetail.locator('strong')).toContainText(['用户问题', '粗体回答']);
    await expect(reviewDetail.locator('ol li')).toHaveCount(2);
    await expect(reviewDetail.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (
      window as typeof window & { __adminUnsafe?: boolean }
    ).__adminUnsafe)).not.toBe(true);
  });

  test('a delayed 401 from an old token does not clear a newer login', async ({ page }) => {
    await loginAsAdmin(page);
    const oldToken = await page.evaluate(() => localStorage.getItem('auth_token'));
    expect(oldToken).toBeTruthy();

    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);
    await expect(page.getByRole('heading', { name: /FAQ\s*管理/ })).toBeVisible();

    let releaseOldRequest: (() => void) | undefined;
    const oldRequestRelease = new Promise<void>((resolve) => {
      releaseOldRequest = resolve;
    });
    let markOldRequestSeen: (() => void) | undefined;
    const oldRequestSeen = new Promise<void>((resolve) => {
      markOldRequestSeen = resolve;
    });
    let capturedOldRequest = false;

    await page.route('**/api/admin/stats/overview**', async (route) => {
      if (capturedOldRequest) {
        await route.continue();
        return;
      }
      capturedOldRequest = true;
      expect(route.request().headers()['authorization']).toBe(`Bearer ${oldToken}`);
      markOldRequestSeen?.();
      await oldRequestRelease;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, data: null, message: 'Invalid token' }),
      });
    });

    await page.locator('.app-admin-sidebar').getByText('数据概览').click();
    await oldRequestSeen;

    let expireCurrentSession = true;
    await page.route('**/api/admin/faq**', async (route) => {
      if (expireCurrentSession && route.request().method() === 'GET') {
        expireCurrentSession = false;
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ code: 401, data: null, message: 'Invalid token' }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('.app-admin-sidebar').getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/login$/);

    await page.waitForTimeout(1_100);
    await page.getByTestId('login-username').locator('input').fill('admin');
    await page.getByTestId('login-password').locator('input').fill('admin123');
    const [loginResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/auth/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);
    expect(loginResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    const newToken = await page.evaluate(() => localStorage.getItem('auth_token'));
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    const old401Response = page.waitForResponse((response) => (
      response.url().includes('/api/admin/stats/overview')
      && response.status() === 401
      && response.request().headers()['authorization'] === `Bearer ${oldToken}`
    ));
    releaseOldRequest?.();
    await (await old401Response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    await expect(page).toHaveURL(/\/admin$/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('auth_token'))).toBe(newToken);
  });

  test('FAQ page exposes index status and rebuild action for admins', async ({ page }) => {
    await loginAsAdmin(page);

    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);
    await expect(page.getByRole('heading', { name: /FAQ\s*管理/ })).toBeVisible();
    await expect(page.getByTestId('faq-index-status')).toContainText('索引状态');
    await expect(page.getByTestId('faq-index-status')).toContainText(/已索引|加载中/);
    const listTab = page.getByRole('tab', { name: 'FAQ列表' });
    const debugTab = page.getByRole('tab', { name: '检索调试' });
    await expect(listTab).toHaveAttribute('aria-selected', 'true');
    await expect(debugTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('faq-debug-panel')).toHaveCount(0);

    const rebuildButton = page.getByTestId('faq-rebuild-index-button');
    await expect(rebuildButton).toBeVisible();
    await rebuildButton.click();
    await expect(page.getByText('FAQ索引已重建')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('faq-index-status')).toContainText('已索引');

    await listTab.focus();
    await listTab.press('ArrowRight');
    await expect(debugTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('faq-debug-panel')).toBeVisible();
    await page.getByTestId('faq-debug-query').locator('input').fill('如何申请退款？');
    const [debugResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/admin/faq/search/debug')),
      page.getByTestId('faq-debug-submit').click(),
    ]);
    expect(debugResponse.status()).toBe(200);
    await expect(page.getByTestId('faq-debug-results')).toContainText('如何申请退款？');
    await expect(page.getByTestId('faq-debug-results')).toContainText('最佳分');
    await expect(page.getByTestId('faq-debug-results')).toContainText(/keyword|vector|hybrid/);
  });

  test('FAQ filters reset to their defaults', async ({ page }) => {
    await loginAsAdmin(page);
    const listRequests: string[] = [];
    await page.route('**/api/admin/faq?**', async (route) => {
      listRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });
    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);
    await expect.poll(() => listRequests.length).toBeGreaterThan(0);
    const initialRequestCount = listRequests.length;

    const keywordInput = page.getByPlaceholder('搜索问题关键词...');
    const categoryInput = page.locator('.app-toolbar-row .t-select input');
    await keywordInput.fill('退款');
    await categoryInput.click();
    await page.getByText('退款', { exact: true }).last().click();
    await page.waitForTimeout(250);
    expect(listRequests).toHaveLength(initialRequestCount);

    await page.getByRole('button', { name: '查询' }).click();
    await expect.poll(() => listRequests.length).toBe(initialRequestCount + 1);
    const submittedUrl = new URL(listRequests.at(-1)!);
    expect(submittedUrl.searchParams.get('keyword')).toBe('退款');
    expect(submittedUrl.searchParams.get('category')).toBe('refund');

    const resetRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/api/admin/faq')
        && !url.searchParams.has('keyword')
        && !url.searchParams.has('category');
    });
    await page.getByTestId('faq-filter-reset').click();
    await resetRequestPromise;
    await expect(keywordInput).toHaveValue('');
    await expect(categoryInput).toHaveValue('全部 类别');
  });

  test('FAQ answer focus ring belongs to the textarea, not its counter row', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('FAQ管理').click();
    await page.getByRole('button', { name: '新增FAQ' }).click();

    const textarea = page.locator('.t-dialog .t-textarea__inner');
    const wrapper = page.locator('.t-dialog .t-textarea');
    const counter = page.locator('.t-dialog .t-textarea__info_wrapper');
    await textarea.fill('边框测试');
    await textarea.focus();

    const styles = await Promise.all([
      textarea.evaluate((element) => {
        const style = getComputedStyle(element);
        return { borderWidth: style.borderTopWidth, boxShadow: style.boxShadow };
      }),
      wrapper.evaluate((element) => {
        const style = getComputedStyle(element);
        return { borderWidth: style.borderTopWidth, boxShadow: style.boxShadow };
      }),
      counter.evaluate((element) => {
        const style = getComputedStyle(element);
        return { borderWidth: style.borderTopWidth, boxShadow: style.boxShadow };
      }),
    ]);

    expect(styles[0].borderWidth).toBe('1px');
    expect(styles[0].boxShadow).not.toBe('none');
    expect(styles[1]).toEqual({ borderWidth: '0px', boxShadow: 'none' });
    expect(styles[2]).toEqual({ borderWidth: '0px', boxShadow: 'none' });
  });

  test('table action buttons keep fixed colors without hover effects', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('FAQ管理').click();
    await expect(page).toHaveURL(/\/admin\/faq$/);

    const actionButtons = page.locator('.app-table-action-button');
    await expect(actionButtons.first()).toBeVisible();
    const readStyles = () => actionButtons.evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        color: style.color,
        transitionDuration: style.transitionDuration,
      };
    }));

    const lightStyles = await readStyles();
    expect(lightStyles.length).toBeGreaterThan(1);
    expect(lightStyles).toEqual(lightStyles.map(() => ({
      backgroundColor: 'rgb(255, 255, 255)',
      borderColor: 'rgb(235, 235, 235)',
      boxShadow: 'none',
      color: 'rgb(23, 23, 23)',
      transitionDuration: '0s',
    })));
    await actionButtons.first().hover();
    expect(await readStyles()).toEqual(lightStyles);

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const expectedDarkStyles = lightStyles.map(() => ({
      backgroundColor: 'rgb(10, 10, 10)',
      borderColor: 'rgb(38, 38, 38)',
      boxShadow: 'none',
      color: 'rgb(255, 255, 255)',
      transitionDuration: '0s',
    }));
    await expect.poll(readStyles).toEqual(expectedDarkStyles);
    const darkStyles = await readStyles();
    await actionButtons.first().hover();
    expect(await readStyles()).toEqual(darkStyles);
  });

  test('admin uploads a document, previews chunks, and customers retrieve its source text', async ({ page }) => {
    const fileName = 'refund-policy.md';
    await loginAsAdmin(page);
    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    await page.getByText('文档知识').click();
    await expect(page).toHaveURL(/\/admin\/documents$/);
    await expect(page.getByTestId('documents-page')).toBeVisible();

    let documentId: string | undefined;
    try {
      const [uploadResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/admin/documents') && response.request().method() === 'POST'),
        page.locator('input[type="file"]').setInputFiles('tests/fixtures/refund-policy.md'),
      ]);
      expect(uploadResponse.status()).toBe(201);
      documentId = (await uploadResponse.json()).data.id as string;
      const row = documentRow(page, fileName);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText('可检索');
      await expect(row).toContainText('MD');
      await expect(page.locator('.t-upload')).not.toContainText(fileName);
      await expect.poll(() => page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ))).toBeLessThanOrEqual(0);
      await expect(page.locator('.app-admin-sidebar')).toBeVisible();
      await expect.poll(() => page.locator('.app-admin-sidebar').evaluate((element) => (
        Math.round(element.getBoundingClientRect().width)
      ))).toBeGreaterThan(200);
      if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
        await expect(page.getByText('登录成功')).toBeHidden({ timeout: 8_000 });
        await expect(page.getByText('文档已解析并加入检索')).toBeHidden({ timeout: 8_000 });
        await page.screenshot({ path: 'docs/releases/assets/v0.2.6-documents.png', fullPage: true });
      }

      await row.getByTestId('document-view').click();
      await expect(page.getByTestId('document-detail')).toBeVisible();
      await expect(page.getByTestId('document-detail')).toContainText('三个工作日');
      await expect.poll(() => page.getByTestId('document-chunk-preview-text').first().evaluate((element) => (
        element.scrollWidth > element.clientWidth
      ))).toBe(true);
      await page.getByTestId('document-chunk-view').first().click();
      await expect(page.getByTestId('document-chunk-content')).toContainText('请联系人工客服处理');
      await page.getByTestId('document-chunk-content-close').click();
      if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
        await page.waitForTimeout(350);
        await page.screenshot({ path: 'docs/releases/assets/v0.2.6-document-detail.png', fullPage: true });
      }
      await page.getByTestId('document-detail-close').click();

      await page.getByTestId('language-toggle').click();
      await expect(page.getByRole('heading', { name: 'Document Knowledge' })).toBeVisible();
      await expect(page.getByTestId('document-filter-reset')).toContainText('Reset');
      await expect(documentRow(page, fileName)).toContainText('Ready');
      await page.getByTestId('theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const filters = page.locator('.app-toolbar-row .t-select input');
      await expect(filters).toHaveCount(2);
      await expect(filters.nth(0)).toHaveValue('All');
      await expect(filters.nth(1)).toHaveValue('All');
      await expect(page.getByRole('button', { name: 'admin' })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('documents-page')).toBeVisible();
      await row.getByTestId('document-view').click();
      await page.getByTestId('document-chunk-view').first().click();
      await expect(page.getByText('Chunk source text', { exact: true })).toBeVisible();
      await expect(page.getByTestId('document-chunk-content')).toContainText('请联系人工客服处理');
      await expect.poll(() => page.locator('.app-document-chunk-dialog').evaluate((element) => (
        element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().width <= window.innerWidth
      ))).toBe(true);
      await expect(page.getByTestId('document-chunk-content-close')).toBeVisible();
      await page.getByTestId('document-chunk-content-close').click();
      await page.getByTestId('document-detail-close').click();
      await expect.poll(() => page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ))).toBeLessThanOrEqual(0);
      if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
        await page.screenshot({ path: 'docs/releases/assets/v0.2.6-documents-mobile-dark.png', fullPage: true });
      }

      await page.goto('/');
      await page.getByTestId('chat-input').fill('银杏计划退款审核通过后，会在三个工作日内原路返回。');
      await page.getByTestId('chat-send-button').click();
      await expect(page.getByTestId('chat-messages')).toContainText(fileName, { timeout: 15_000 });
      await expect(page.getByTestId('chat-messages')).toContainText('三个工作日');
      await expect(page.getByTestId('chat-document-references')).toContainText(fileName);
    } finally {
      if (documentId) {
        const deleted = await page.request.delete(`/api/admin/documents/${documentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleted.status()).toBe(200);
      }
    }
  });

  test('document filters apply only after search is submitted', async ({ page }) => {
    await loginAsAdmin(page);
    const listRequests: string[] = [];
    await page.route('**/api/admin/documents?**', async (route) => {
      listRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });

    await page.getByText('文档知识').click();
    await expect(page).toHaveURL(/\/admin\/documents$/);
    await page.waitForTimeout(250);
    const initialRequestCount = listRequests.length;
    expect(initialRequestCount).toBeGreaterThan(0);

    await page.getByPlaceholder('搜索文件名').fill('catalog');
    const filters = page.locator('.app-toolbar-row .t-select input');
    await filters.nth(0).click();
    await page.getByText('可检索', { exact: true }).last().click();
    await filters.nth(1).click();
    await page.getByText('已停用', { exact: true }).last().click();
    await page.waitForTimeout(250);
    expect(listRequests).toHaveLength(initialRequestCount);

    await page.getByRole('button', { name: '查询' }).click();
    await expect.poll(() => listRequests.length).toBe(initialRequestCount + 1);
    const submittedUrl = new URL(listRequests.at(-1)!);
    expect(submittedUrl.searchParams.get('keyword')).toBe('catalog');
    expect(submittedUrl.searchParams.get('status')).toBe('ready');
    expect(submittedUrl.searchParams.get('isActive')).toBe('false');

    await page.getByTestId('document-filter-reset').click();
    await expect.poll(() => listRequests.length).toBe(initialRequestCount + 2);
    const resetUrl = new URL(listRequests.at(-1)!);
    expect(resetUrl.searchParams.get('keyword')).toBeNull();
    expect(resetUrl.searchParams.get('status')).toBeNull();
    expect(resetUrl.searchParams.get('isActive')).toBeNull();
    await expect(page.getByPlaceholder('搜索文件名')).toHaveValue('');
    await expect(filters.nth(0)).toHaveValue('全部');
    await expect(filters.nth(1)).toHaveValue('全部');
  });

  test('document reset keeps the newest response when an old filter request finishes late', async ({ page }) => {
    await loginAsAdmin(page);
    let releaseFilteredRequest: (() => void) | undefined;
    const filteredRequestRelease = new Promise<void>((resolve) => {
      releaseFilteredRequest = resolve;
    });
    let markFilteredRequestSeen: (() => void) | undefined;
    const filteredRequestSeen = new Promise<void>((resolve) => {
      markFilteredRequestSeen = resolve;
    });

    const documentItem = (id: string, fileName: string) => ({
      id,
      fileName,
      format: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
      status: 'ready',
      isActive: 1,
      parserVersion: 'text-v1',
      chunkerVersion: 'semantic-v1',
      failureCode: null,
      characterCount: 50,
      chunkCount: 1,
      uploadedBy: 'admin-1',
      createdAt: '2026-07-15T10:00:00.000Z',
      updatedAt: '2026-07-15T10:00:00.000Z',
    });

    await page.route('**/api/admin/documents?**', async (route) => {
      const url = new URL(route.request().url());
      const filtered = url.searchParams.get('keyword') === 'catalog';
      if (filtered) {
        markFilteredRequestSeen?.();
        await filteredRequestRelease;
      }
      const item = filtered
        ? documentItem('filtered', 'filtered-result.txt')
        : documentItem('default', 'default-result.txt');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [item], total: 1, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });

    await page.getByText('文档知识').click();
    await expect(documentRow(page, 'default-result.txt')).toBeVisible();
    await page.getByPlaceholder('搜索文件名').fill('catalog');
    await page.getByRole('button', { name: '查询' }).click();
    await filteredRequestSeen;
    await page.getByTestId('document-filter-reset').click();
    await expect(documentRow(page, 'default-result.txt')).toBeVisible();
    const oldFilteredResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/api/admin/documents')
        && url.searchParams.get('keyword') === 'catalog';
    });
    releaseFilteredRequest?.();
    await (await oldFilteredResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(documentRow(page, 'filtered-result.txt')).toHaveCount(0);
    await expect(documentRow(page, 'default-result.txt')).toBeVisible();
  });

  test('failed documents explain the cause and recovery action', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/documents?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            items: [{
              id: 'failed-document',
              fileName: 'embedding-failure.txt',
              format: 'txt',
              mimeType: 'text/plain',
              sizeBytes: 1024,
              status: 'failed',
              isActive: 1,
              parserVersion: 'text-v1',
              chunkerVersion: 'semantic-v1',
              failureCode: 'embedding_failed',
              characterCount: 0,
              chunkCount: 0,
              uploadedBy: 'admin-1',
              createdAt: '2026-07-15T10:00:00.000Z',
              updatedAt: '2026-07-15T10:00:00.000Z',
            }],
            total: 1,
            page: 1,
            pageSize: 20,
          },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/documents/failed-document/chunks?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 10 },
          message: 'ok',
        }),
      });
    });

    await page.getByText('文档知识').click();
    await expect(page).toHaveURL(/\/admin\/documents$/);
    const row = documentRow(page, 'embedding-failure.txt');
    await expect(row).toContainText('向量生成失败');
    await row.getByTestId('document-view').click();
    const detail = page.getByTestId('document-detail');
    await expect(detail).toContainText('embedding_failed');
    await expect(detail).toContainText('请检查模型配置中的 Embedding 地址、模型和 API Key，确认服务可用后重试');

    await page.getByTestId('document-detail-close').click();
    await page.getByTestId('language-toggle').click();
    await expect(row).toContainText('Embedding generation failed');
    await row.getByTestId('document-view').click();
    await expect(detail).toContainText('Embedding generation failed');
    await expect(detail).toContainText('Check the Embedding endpoint, model, and API key in Model Configuration, then retry');
  });

  test('knowledge review filters reset to their defaults', async ({ page }) => {
    await loginAsAdmin(page);
    const listRequests: string[] = [];
    await page.route('**/api/admin/knowledge-reviews?**', async (route) => {
      listRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });
    await page.getByText('知识审核').click();
    await expect(page).toHaveURL(/\/admin\/knowledge-review$/);
    await expect.poll(() => listRequests.length).toBeGreaterThan(0);
    const initialRequestCount = listRequests.length;

    const keywordInput = page.getByPlaceholder('搜索问题或回答');
    const filters = page.locator('.app-toolbar-row .t-select input');
    await keywordInput.fill('退款');
    await filters.nth(0).click();
    await page.getByText('已转换', { exact: true }).last().click();
    await filters.nth(1).click();
    await page.getByText('用户负反馈', { exact: true }).last().click();
    await page.waitForTimeout(250);
    expect(listRequests).toHaveLength(initialRequestCount);

    await page.getByRole('button', { name: '查询' }).click();
    await expect.poll(() => listRequests.length).toBe(initialRequestCount + 1);
    const submittedUrl = new URL(listRequests.at(-1)!);
    expect(submittedUrl.searchParams.get('keyword')).toBe('退款');
    expect(submittedUrl.searchParams.get('status')).toBe('converted');
    expect(submittedUrl.searchParams.get('triggerReason')).toBe('negative_feedback');

    const resetRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/api/admin/knowledge-reviews')
        && url.searchParams.get('status') === 'pending'
        && !url.searchParams.has('keyword')
        && !url.searchParams.has('triggerReason');
    });
    await page.getByTestId('knowledge-review-filter-reset').click();
    await resetRequestPromise;
    await expect(keywordInput).toHaveValue('');
    await expect(filters.nth(0)).toHaveValue('待审核');
    await expect(filters.nth(1)).toHaveValue('全部');
  });

  test('admin reviews a knowledge gap, inspects evidence, and converts it to a searchable FAQ', async ({ page }) => {
    const question = `yyyyyyyyyyyyyyyy-web-${Date.now()}`;
    await page.goto('/');
    await page.getByTestId('chat-input').fill(question);
    const [chatResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/chat') && response.request().method() === 'POST'),
      page.getByTestId('chat-send-button').click(),
    ]);
    await chatResponse.finished();
    await expect(page.getByTestId('chat-messages')).toContainText(question);

    await loginAsAdmin(page);
    await page.getByText('知识审核').click();
    await expect(page).toHaveURL(/\/admin\/knowledge-review$/);
    await expect(page.getByTestId('knowledge-review-page')).toBeVisible();
    await expect(page.getByTestId('knowledge-review-table')).toContainText(question);
    const reviewRow = knowledgeReviewRow(page, question);
    await expect(reviewRow).toBeVisible();

    await reviewRow.getByTestId('knowledge-review-view').click();
    await expect(page.getByTestId('knowledge-review-detail')).toContainText('当时的检索依据');
    await expect(page.getByTestId('knowledge-review-detail')).toContainText(/vector|keyword|hybrid/);
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await expect(page.getByText('登录成功')).toBeHidden({ timeout: 8_000 });
      await page.screenshot({ path: 'docs/releases/assets/v0.2.5-review-detail.png', fullPage: true });
    }
    await page.getByRole('button', { name: '关闭' }).click();

    await reviewRow.getByTestId('knowledge-review-convert').click();
    await page.getByTestId('knowledge-convert-answer').fill('来自管理员审核的闭环答案');
    const [convertResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/admin/knowledge-reviews/') && response.url().endsWith('/convert')),
      page.getByRole('button', { name: '转为 FAQ', exact: true }).last().click(),
    ]);
    expect(convertResponse.status()).toBe(200);
    await expect(page.getByText('已转换为 FAQ 并同步索引')).toBeVisible();
    await expect(page.getByTestId('knowledge-review-stats')).toContainText('已转 FAQ');
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await expect(page.getByText('编辑并转为 FAQ')).toBeHidden({ timeout: 8_000 });
      await page.screenshot({ path: 'docs/releases/assets/v0.2.5-converted.png', fullPage: true });
    }

    const searchResponse = await page.request.get(`/api/faq/search?q=${encodeURIComponent(question)}`);
    expect(searchResponse.status()).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.data[0]).toMatchObject({
      question,
      answer: '来自管理员审核的闭环答案',
    });

    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'Knowledge Review' })).toBeVisible();
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('knowledge-review-page')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const inspect = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          selector,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: getComputedStyle(element).overflowX,
        };
      };
      return {
        document: {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
        },
        elements: [
          '.app-admin-layout',
          '.app-admin-sidebar',
          '.app-admin-sidebar .t-menu',
          '.app-content',
          '.app-page-container',
          '.app-table-card',
          '.app-table-card .t-card__body',
          '.app-table-card .t-table',
        ].map(inspect),
      };
    });
    expect(
      overflow.document.scrollWidth,
      `mobile overflow: ${JSON.stringify(overflow)}`,
    ).toBeLessThanOrEqual(overflow.document.clientWidth);
  });

  test('admin can dismiss a pending knowledge review with a reason', async ({ page }) => {
    const question = `kkkkkkkkkkkkkkkk-dismiss-${Date.now()}`;
    const chatResponse = await page.request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: question, userIdent: `dismiss-user-${Date.now()}` },
    });
    expect(chatResponse.status()).toBe(200);

    await loginAsAdmin(page);
    await page.getByText('知识审核').click();
    await expect(page.getByTestId('knowledge-review-table')).toContainText(question);
    const reviewRow = knowledgeReviewRow(page, question);
    await expect(reviewRow).toBeVisible();
    await reviewRow.getByTestId('knowledge-review-dismiss').click();
    await page.getByTestId('knowledge-dismiss-reason').fill('重复或无业务价值');
    const [dismissResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/dismiss')),
      page.getByRole('button', { name: '忽略', exact: true }).last().click(),
    ]);
    expect(dismissResponse.status()).toBe(200);
    await expect(page.getByText('审核记录已忽略')).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    const dismissedList = await page.request.get('/api/admin/knowledge-reviews', {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'dismissed', keyword: question },
    });
    expect(dismissedList.status()).toBe(200);
    const body = await dismissedList.json();
    expect(body.data.items[0]).toMatchObject({
      status: 'dismissed',
      dismissReason: '重复或无业务价值',
    });
  });
});
