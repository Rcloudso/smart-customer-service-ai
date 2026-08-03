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
  await expect(page).toHaveURL(/\/admin(?:\/getting-started)?$/);
  await page.waitForLoadState('networkidle');
  if (new URL(page.url()).pathname === '/admin/getting-started') {
    await page.getByRole('button', { name: '暂时跳过' }).click();
    await expect(page).toHaveURL(/\/admin$/);
  }
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

    await expect(page.getByRole('heading', { name: 'ResolveWeave' })).toBeVisible();
    await expect(page.getByText('企业级智能客服平台', { exact: true })).toBeVisible();
    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'ResolveWeave' })).toBeVisible();
    await expect(page.getByText('Enterprise Customer Service Platform', { exact: true })).toBeVisible();
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
              sourceBlockIds: ['block-000003', 'block-000004'],
              extractionJobId: '11111111-1111-4111-8111-111111111111',
              extractionEngine: 'paddleocr_ppstructurev3',
              extractionEngineVersion: '3.0.0',
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
    await expect(page.getByTestId('chat-document-references')).toContainText('PaddleOCR PP-StructureV3 3.0.0');
    await expect(page.getByTestId('chat-document-references')).toContainText('block-000003');
    await expect(page.getByTestId('chat-document-references')).toContainText('提取任务 11111111');
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

  test('rapid chat submission sends one idempotent request', async ({ page }) => {
    const requestHeaders: string[] = [];
    await page.route('**/api/chat', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      requestHeaders.push(route.request().headers()['idempotency-key'] ?? '');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          { type: 'intent', content: 'general', confidence: 0.9 },
          { type: 'token', content: '只处理一次' },
          {
            type: 'done',
            content: {
              sessionId: 'single-flight-session',
              messageId: 'single-flight-message',
              intent: 'general',
            },
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('快速重复发送');
    await page.getByTestId('chat-send-button').evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });

    await expect(page.getByTestId('chat-messages')).toContainText('只处理一次');
    expect(requestHeaders).toHaveLength(1);
    expect(requestHeaders[0]).toMatch(/^[a-f0-9-]{36}$/);
  });

  test('failed satisfaction submission unlocks the rating control for retry', async ({ page }) => {
    let ratingRequests = 0;
    await page.route('**/api/chat**', async (route) => {
      if (route.request().url().includes('/satisfaction')) {
        ratingRequests += 1;
        await route.fulfill({
          status: ratingRequests === 1 ? 503 : 200,
          contentType: 'application/json',
          body: JSON.stringify(ratingRequests === 1
            ? { code: 503, data: null, message: 'retry rating' }
            : { code: 0, data: null, message: 'ok' }),
        });
        return;
      }
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          { type: 'intent', content: 'general', confidence: 0.9 },
          { type: 'token', content: '可以评价的回答' },
          {
            type: 'done',
            content: {
              sessionId: 'rating-retry-session',
              messageId: 'rating-retry-message',
              intent: 'general',
            },
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('评分重试');
    await page.getByTestId('chat-send-button').click();
    const rating = page.getByTitle('非常满意');
    await expect(rating).toBeEnabled();

    await rating.click();
    await expect(rating).toBeEnabled();
    await expect(page.getByText('已评价')).toHaveCount(0);

    await rating.click();
    await expect(page.getByText('已评价')).toBeVisible();
    expect(ratingRequests).toBe(2);
  });
});

test.describe('Web automation: first value and responsive operations', () => {
  test('fresh admin completes the no-key grounded onboarding flow', async ({ page }) => {
    test.setTimeout(60_000);
    await clearBrowserState(page);
    await page.goto('/login');
    await page.getByTestId('login-username').locator('input').fill('admin');
    await page.getByTestId('login-password').locator('input').fill('admin123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/\/admin\/getting-started$/);
    await expect(page.getByTestId('getting-started-page')).toBeVisible();

    const appReadyAt = Date.now();
    await page.getByRole('button', { name: '开始首次体验' }).click();
    await page.getByRole('button', { name: '加载 sample-pack-v1' }).click();
    await expect(page.getByText('样例已加载', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '发送推荐问题' }).click();
    await expect(page.getByTestId('onboarding-answer')).toContainText('7');
    await expect(page.getByTestId('onboarding-sources')).toContainText('document');
    await expect(page.getByTestId('onboarding-sources')).toContainText('demo-return-policy-bilingual.md');
    expect(Date.now() - appReadyAt).toBeLessThanOrEqual(60_000);

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: /first grounded answer/i })).toBeVisible();
    await page.getByRole('button', { name: 'I reviewed the source' }).click();
    await expect(page.getByText('Getting started complete', { exact: true })).toBeVisible();
    await page.getByTestId('language-toggle').click();
    await page.getByTestId('theme-toggle').click();
  });

  test('390px admin uses a full-label keyboard-closeable Drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await clearBrowserState(page);
    await loginAsAdmin(page);
    const trigger = page.getByRole('button', { name: '打开后台导航' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const drawer = page.locator('.app-mobile-nav-drawer');
    await expect(drawer.getByText('运行中心', { exact: true })).toBeVisible();
    await expect(drawer.getByText('检索运维', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('后台导航', { exact: true })).toBeHidden();
    await trigger.click();
    await drawer.getByText('运行中心', { exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/operations$/);
    await expect(page.getByTestId('operations-page')).toBeVisible();
    await expect(page.getByText('可选未启用', { exact: true }).first()).toBeVisible();
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

  test('escalation triage supports queue-to-evidence flow, states, language, theme and mobile width', async ({ page }) => {
    const escalationId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const userMessageId = '33333333-3333-4333-8333-333333333333';
    let listMode: 'data' | 'empty' | 'error' = 'data';
    const packet = {
      escalationId,
      sessionId,
      schemaVersion: 1,
      ruleVersion: 'triage_v1',
      summary: '客户要求查询订单 TRIAGE-100 的私有状态',
      category: 'order',
      priority: 'high',
      reasonCode: 'unsupported_business_action',
      reason: '当前请求涉及尚未授权的业务操作，需要人工处理',
      riskFlags: ['private_data_required', 'business_action_required'],
      confirmedFacts: [{
        label: 'order_id',
        value: 'TRIAGE-100',
        sourceMessageId: userMessageId,
        sourceExcerpt: '订单 TRIAGE-100',
      }],
      missingInformation: ['authorized_identity_context'],
      evidenceSources: [{
        knowledgeType: 'document',
        knowledgeId: 'chunk-triage',
        documentId: 'document-triage',
        title: '订单处理规范.pdf',
        similarity: 0.87,
        chunkIndex: 2,
        pageStart: 4,
        pageEnd: 4,
      }],
      recommendedQueue: 'order_support',
      suggestedNextStep: 'Prioritize human review.',
      extractionMode: 'deterministic',
      createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await page.route('**/api/admin/escalations**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/${escalationId}`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 0,
            message: 'ok',
            data: {
              escalation: {
                id: escalationId,
                sessionId,
                reason: packet.reason,
                status: 'pending',
                resolvedAt: null,
                createdAt: packet.createdAt,
              },
              packet,
              session: {
                id: sessionId,
                userIdent: 'triage-web-user',
                status: 'escalated',
                createdAt: packet.createdAt,
                updatedAt: packet.updatedAt,
                closedAt: null,
                closeReason: null,
              },
              referencedMessageIds: [userMessageId],
              messages: [
                {
                  id: userMessageId,
                  role: 'user',
                  content: '请查询订单 TRIAGE-100 的私有状态并转人工',
                  intent: 'order',
                  intentConf: 0.96,
                  retrievalSnapshot: [],
                  answerMode: null,
                  groundingStatus: null,
                  groundingReason: null,
                  retrievalPolicyId: null,
                  satisfaction: null,
                  escalated: 0,
                  createdAt: packet.createdAt,
                },
                {
                  id: '44444444-4444-4444-8444-444444444444',
                  role: 'assistant',
                  content: '需要人工处理',
                  intent: 'order',
                  intentConf: 0.96,
                  retrievalSnapshot: packet.evidenceSources,
                  answerMode: 'refusal',
                  groundingStatus: 'high_risk',
                  groundingReason: 'unsupported_business_action',
                  retrievalPolicyId: 'policy-1',
                  satisfaction: null,
                  escalated: 1,
                  createdAt: packet.updatedAt,
                },
              ],
            },
          }),
        });
        return;
      }
      if (listMode === 'error') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 503, data: null, message: 'mock triage failure' }),
        });
        return;
      }
      const items = listMode === 'empty' ? [] : [{
        id: escalationId,
        sessionId,
        userIdent: 'triage-web-user',
        reason: packet.reason,
        status: 'pending',
        resolvedAt: null,
        createdAt: packet.createdAt,
        packet,
      }];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: 'ok',
          data: { items, total: items.length, page: 1, pageSize: 20 },
        }),
      });
    });

    await loginAsAdmin(page);
    await page.getByText('转人工分流', { exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/escalations$/);
    await expect(page.getByTestId('escalation-triage-page')).toContainText(packet.summary);
    await expect(page.getByTestId('escalation-triage-table')).toContainText('高');
    await expect(page.getByTestId('escalation-triage-table')).toContainText('订单支持');
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.locator('.t-message').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.9-triage-desktop.png',
        fullPage: true,
      });
    }

    await page.getByRole('button', { name: packet.summary }).click();
    const detail = page.getByTestId('escalation-triage-detail');
    await expect(detail).toContainText('建议下一步');
    await expect(detail).toContainText('TRIAGE-100');
    await expect(detail).toContainText('订单处理规范.pdf');
    const citedMessage = page.getByTestId(`triage-message-${userMessageId}`);
    await expect(citedMessage).toContainText('事实引用');
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.locator('.t-dialog:visible').evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.9-triage-detail.png',
        fullPage: true,
      });
    }
    await detail.getByRole('button', { name: /订单编号/ }).click();
    await expect(citedMessage).toHaveClass(/app-triage-message--referenced/);
    await expect(citedMessage).toBeFocused();

    await page.locator('.t-dialog:visible .t-dialog__close').click();
    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'Escalation Triage' })).toBeVisible();
    await page.getByRole('button', { name: packet.summary }).click();
    await expect(detail).toContainText('Suggested next step');
    await page.locator('.t-dialog:visible .t-dialog__close').click();
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('escalation-triage-page')).toBeVisible();
    expect(
      await page.getByTestId('escalation-triage-page').locator('.t-input').first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(23, 23, 23)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.9-triage-mobile-dark.png',
        fullPage: true,
      });
    }

    listMode = 'empty';
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('No escalations match the current filters')).toBeVisible();

    listMode = 'error';
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('mock triage failure')).toBeVisible();
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

  test('rapid model save sends one idempotent update', async ({ page }) => {
    let updateRequests = 0;
    let idempotencyKey = '';
    await page.route('**/api/admin/config/model', async (route) => {
      if (route.request().method() === 'PUT') {
        updateRequests += 1;
        idempotencyKey = route.request().headers()['idempotency-key'] ?? '';
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 0, data: null, message: 'ok' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            llmProvider: 'openai',
            llmApiBase: '',
            llmModel: 'gpt-4o-mini',
            embedProvider: 'openai',
            embedApiBase: '',
            embedModel: 'text-embedding-3-small',
            llmApiKeyConfigured: false,
            embedApiKeyConfigured: false,
          },
          message: 'ok',
        }),
      });
    });

    await loginAsAdmin(page);
    await page.getByText('模型配置').click();
    const save = page.getByRole('button', { name: '保存' });
    await expect(save).toBeVisible();
    await save.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });

    await expect.poll(() => updateRequests).toBe(1);
    expect(idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
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
    await expect(page.getByTestId('llm-api-base-field').locator('input')).toBeDisabled();
    await expect(page.getByTestId('embed-api-base-field').locator('input')).toBeDisabled();
    await expect(page.getByTestId('llm-api-base-field')).toContainText('LLM_API_BASE');

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
    const selectedDate = submittedUrl.searchParams.get('from');
    expect(selectedDate).toMatch(/^\d{4}-\d{2}-17$/);
    expect(submittedUrl.searchParams.get('to')).toBe(selectedDate);
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
    expect(exported.searchParams.get('from')).toBe(selectedDate);
    expect(exported.searchParams.get('to')).toBe(selectedDate);
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
      await expect(page.getByTestId('document-quality-decision')).toContainText('质量通过');
      await expect(page.getByTestId('document-processing-timeline')).toContainText('质量门禁');
      await expect(page.getByTestId('document-processing-timeline')).toContainText('发布');
      await expect(page.getByTestId('document-block-preview').filter({ hasText: '银杏计划' })).toBeVisible();
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
      await expect(page.getByTestId('document-quality-decision')).toContainText('Quality passed');
      await expect(page.getByTestId('document-processing-timeline')).toContainText('Quality gate');
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

  test('admin reviews, saves, and publishes OCR blocks as one document', async ({ page }) => {
    await loginAsAdmin(page);
    const documentId = '4f785280-bd31-4e70-a574-ef0f3745fb74';
    let published = false;
    let savedRevision = 1;
    const draftBlocks = [{
      id: 'block-000001',
      order: 0,
      kind: 'paragraph',
      pageNumber: 1,
      headingPath: [],
      confidence: 0.94,
      layout: { x: 12, y: 24, width: 480, height: 72 },
      excluded: false,
      exclusionReason: null,
      text: '签收后七天内可以申请退款。',
      manuallyEdited: savedRevision > 1,
    }, {
      id: 'block-000002',
      order: 1,
      kind: 'list',
      pageNumber: 1,
      headingPath: ['退款政策'],
      confidence: 0.9,
      layout: null,
      excluded: false,
      exclusionReason: null,
      ordered: false,
      items: [
        { ordinal: 0, text: '保持商品完好' },
        { ordinal: 1, text: '提交订单编号' },
      ],
      manuallyEdited: false,
    }];
    const documentItem = () => ({
      id: documentId,
      fileName: 'refund-policy.png',
      format: 'png',
      mimeType: 'image/png',
      sizeBytes: 2_048,
      status: published ? 'ready' : 'failed',
      isActive: 1,
      parserVersion: published ? 'paddleocr_ppstructurev3-reviewed' : 'ocr-pending',
      chunkerVersion: published ? 'semantic-v1' : 'not_processed',
      failureCode: published ? null : 'ocr_review_required',
      characterCount: published ? 42 : 0,
      chunkCount: published ? 1 : 0,
      qualityDecision: published ? 'ready' : 'review_required',
      qualityReasons: published ? [] : ['ocr_review_required'],
      indexStatus: published ? 'published' : 'not_indexed',
      uploadedBy: 'admin',
      createdAt: '2026-07-27T10:00:00.000Z',
      updatedAt: '2026-07-27T10:00:00.000Z',
    });

    await page.route('**/api/admin/documents?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [documentItem()], total: 1, page: 1, pageSize: 20 },
          message: 'ok',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}/review-draft?**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            draftId: 'draft-1',
            revision: savedRevision,
            status: published ? 'published' : 'open',
            items: draftBlocks,
            total: draftBlocks.length,
            page: 1,
            pageSize: 2_000,
          },
          message: 'ok',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}/review-draft`, async (route) => {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        blocks: typeof draftBlocks;
      };
      expect(body.expectedRevision).toBe(1);
      expect(body.blocks[0].text).toContain('七个自然日');
      savedRevision = 2;
      draftBlocks[0] = { ...body.blocks[0], manuallyEdited: true };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            draftId: 'draft-1',
            revision: savedRevision,
            status: 'open',
            items: draftBlocks,
            total: draftBlocks.length,
          },
          message: 'Review draft saved',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}/review-draft/publish`, async (route) => {
      const body = route.request().postDataJSON() as { expectedRevision: number };
      expect(body.expectedRevision).toBe(2);
      published = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            ...documentItem(),
            processingSummary: null,
            representationSummary: null,
            reviewDraftSummary: {
              id: 'draft-1',
              revision: 2,
              status: 'published',
              blockCount: draftBlocks.length,
              manuallyEditedBlockCount: 1,
              updatedBy: 'admin',
              updatedAt: '2026-07-27T10:05:00.000Z',
              publishedAt: '2026-07-27T10:05:00.000Z',
            },
          },
          message: 'Review draft published',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            ...documentItem(),
            processingSummary: null,
            representationSummary: null,
            extractionSummary: {
              jobId: '11111111-1111-4111-8111-111111111111',
              status: 'succeeded',
              role: 'authoritative',
              engine: 'paddleocr_ppstructurev3',
              engineVersion: '3.0.0',
              retryOf: null,
              errorCode: null,
              blockCount: 2,
              warningCodes: [],
              createdAt: '2026-07-27T10:00:00.000Z',
              startedAt: '2026-07-27T10:00:01.000Z',
              completedAt: '2026-07-27T10:00:05.000Z',
            },
            shadowExtractionSummary: {
              jobId: '22222222-2222-4222-8222-222222222222',
              status: 'succeeded',
              role: 'shadow',
              engine: 'deepseek_ocr2',
              engineVersion: '2.0.0',
              retryOf: null,
              errorCode: null,
              blockCount: 2,
              warningCodes: [],
              createdAt: '2026-07-27T10:00:05.000Z',
              startedAt: '2026-07-27T10:00:06.000Z',
              completedAt: '2026-07-27T10:00:09.000Z',
            },
            extractionHistory: [
              {
                jobId: '22222222-2222-4222-8222-222222222222',
                status: 'succeeded',
                role: 'shadow',
                engine: 'deepseek_ocr2',
                engineVersion: '2.0.0',
                retryOf: null,
                errorCode: null,
                blockCount: 2,
                warningCodes: [],
                createdAt: '2026-07-27T10:00:05.000Z',
                startedAt: '2026-07-27T10:00:06.000Z',
                completedAt: '2026-07-27T10:00:09.000Z',
              },
              {
                jobId: '11111111-1111-4111-8111-111111111111',
                status: 'succeeded',
                role: 'authoritative',
                engine: 'paddleocr_ppstructurev3',
                engineVersion: '3.0.0',
                retryOf: null,
                errorCode: null,
                blockCount: 2,
                warningCodes: [],
                createdAt: '2026-07-27T10:00:00.000Z',
                startedAt: '2026-07-27T10:00:01.000Z',
                completedAt: '2026-07-27T10:00:05.000Z',
              },
            ],
            ocrComparisonSummary: {
              status: 'available',
              authoritativeJobId: '11111111-1111-4111-8111-111111111111',
              shadowJobId: '22222222-2222-4222-8222-222222222222',
              blockCountDelta: 0,
              warningCountDelta: 0,
              textAgreement: 0.96,
              structureAgreement: 1,
            },
            reviewDraftSummary: {
              id: 'draft-1',
              revision: savedRevision,
              status: published ? 'published' : 'open',
              blockCount: 2,
              manuallyEditedBlockCount: savedRevision > 1 ? 1 : 0,
              updatedBy: 'admin',
              updatedAt: '2026-07-27T10:05:00.000Z',
              publishedAt: published ? '2026-07-27T10:05:00.000Z' : null,
            },
          },
          message: 'ok',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}/blocks?**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 20, representationVersion: null },
          message: 'ok',
        }),
      });
    });
    await page.route(`**/api/admin/documents/${documentId}/chunks?**`, async (route) => {
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
    const row = documentRow(page, 'refund-policy.png');
    await expect(row).toContainText('OCR 提取完成，等待人工复核');
    await row.getByTestId('document-view').click();
    await expect(page.getByTestId('document-ocr-provenance')).toContainText('PaddleOCR PP-StructureV3 3.0.0');
    await expect(page.getByTestId('document-ocr-provenance')).toContainText('DeepSeek-OCR-2 2.0.0');
    await expect(page.getByTestId('document-ocr-provenance')).toContainText('96%');
    await page.getByTestId('document-detail-close').click();
    await row.getByTestId('document-review').click();
    await expect(page.getByTestId('document-review-dialog')).toBeVisible();
    await expect(page.getByTestId('document-review-dialog')).toContainText('2 个 Block');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.getByTestId('document-review-dialog').evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);
    await page.getByTestId('document-review-close').click();
    await page.getByTestId('language-toggle').click();
    await row.getByTestId('document-review').click();
    await expect(page.getByText('OCR content review', { exact: true })).toBeVisible();
    await expect(page.getByTestId('document-review-dialog')).toContainText('2 blocks');
    await expect(page.getByTestId('document-review-dialog')).toContainText('Previous');
    await page.getByTestId('document-review-text').fill('签收后七个自然日内可以申请退款。');
    await expect(page.getByTestId('document-review-publish')).toHaveClass(/t-is-disabled/);

    await page.getByTestId('document-review-save').click();
    await expect(page.getByTestId('document-review-dialog')).toContainText('Draft v2');
    await expect(page.getByTestId('document-review-publish')).not.toHaveClass(/t-is-disabled/);
    await page.getByTestId('document-review-publish').click();
    await page.getByText(/^(确定|Confirm|OK)$/).last().click();

    await expect(page.getByTestId('document-review-dialog')).toHaveCount(0);
    await expect(row).toContainText('Ready');
    await expect(row).toContainText('1');
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
    await page.route('**/api/admin/documents/failed-document/blocks?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { items: [], total: 0, page: 1, pageSize: 10, representationVersion: null },
          message: 'ok',
        }),
      });
    });
    await page.route('**/api/admin/documents/failed-document', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
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
            processingSummary: null,
            representationSummary: null,
          },
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
    const [ratingResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/chat/satisfaction')),
      page.getByTitle('非常不满意').last().click(),
    ]);
    expect(ratingResponse.status()).toBe(200);

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

  test('quality lab supports bilingual theme and mobile keyboard navigation', async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByText('质量实验室').click();
    await expect(page).toHaveURL(/\/admin\/quality-lab$/);
    await expect(page.getByTestId('quality-lab-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'RAG 质量实验室' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '请选择' })).toHaveValue(/RAG Quality Baseline/);
    await expect(page.getByText('质量实验室加载失败')).toHaveCount(0);
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.getByText('登录成功').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.8-quality-lab-desktop.png',
        fullPage: true,
      });
    }

    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'RAG Quality Lab' })).toBeVisible();
    await expect(page.getByText('Experiment runs')).toBeVisible();
    await page.getByText('Experiment runs').click();
    await expect(page.getByText(/Current matrix: 18 candidates/)).toBeVisible();
    await page.getByText('Runtime policy').click();
    await expect(page.getByRole('heading', { name: 'Policy audit events' })).toBeVisible();
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Tab');
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).not.toBe('BODY');
    await expect.poll(
      () => page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      { message: 'quality lab should settle without page-level mobile overflow' },
    ).toBe(true);
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.2.8-quality-lab-mobile-dark.png',
        fullPage: true,
      });
    }
  });

  test('retrieval operations shows trace timeline across language, theme, mobile and keyboard states', async ({ page }) => {
    const question = `retrieval-trace-web-${Date.now()}`;
    const chatResponse = await page.request.post('/api/chat', {
      headers: { Accept: 'text/event-stream' },
      data: { message: question, userIdent: `trace-web-${Date.now()}` },
    });
    expect(chatResponse.status()).toBe(200);
    const stream = await chatResponse.text();
    const sessionId = stream.match(/"sessionId":"([^"]+)"/)?.[1];
    expect(sessionId).toBeTruthy();

    await loginAsAdmin(page);
    await page.getByText('检索运维').click();
    await expect(page).toHaveURL(/\/admin\/retrieval-ops$/);
    await expect(page.getByTestId('retrieval-ops-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: '检索运维' })).toBeVisible();
    await expect(page.getByText('内存', { exact: true })).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.getByText('登录成功').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-retrieval-ops-desktop.png',
        fullPage: true,
      });
    }

    await page.getByText('检索 Trace').click();
    await page.getByTestId('retrieval-trace-session-filter').locator('input').fill(sessionId!);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    const traceRow = page.getByTestId('retrieval-trace-table').locator('tr').filter({
      hasText: sessionId!,
    });
    await expect(traceRow).toBeVisible();
    await traceRow.getByRole('button', { name: '查看' }).click();
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.getByText('查询扩展', { exact: true })).toBeVisible();
    await expect(page.getByText('Grounding 决策', { exact: true })).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.waitForTimeout(350);
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-retrieval-trace-desktop.png',
        fullPage: true,
      });
    }
    await page.locator('.t-dialog:visible .t-dialog__close').click();

    await page.getByTestId('language-toggle').click();
    await expect(page.getByRole('heading', { name: 'Retrieval operations' })).toBeVisible();
    await expect(page.getByText('Runtime overview')).toBeVisible();
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await expect.poll(
      () => page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      { message: 'retrieval operations should not create page-level mobile overflow' },
    ).toBe(true);
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-retrieval-ops-mobile-dark.png',
        fullPage: true,
      });
    }
  });

  test('retrieval operations gates activation, rollback and error states with optimistic alias values', async ({ page }) => {
    await loginAsAdmin(page);
    const oldCollection = 'resolveweave_knowledge_20260729_old';
    const nextCollection = 'resolveweave_knowledge_20260729_next';
    const oldJobId = '11111111-1111-4111-8111-111111111111';
    const nextJobId = '22222222-2222-4222-8222-222222222222';
    let currentCollection = oldCollection;
    let failRequests = false;
    let jobs = [
      {
        id: nextJobId,
        status: 'ready',
        collection: nextCollection,
        embeddingProfile: 'combined:quality-v1',
        vectorDimension: 64,
        knowledgeFingerprint: 'fingerprint-v1',
        expectedCount: 128,
        completedCount: 128,
        checkpoint: 128,
        previousCollection: null,
        failureCode: null,
        createdBy: 'admin',
        createdAt: '2026-07-29T08:00:00.000Z',
        startedAt: '2026-07-29T08:00:01.000Z',
        readyAt: '2026-07-29T08:00:03.000Z',
        activatedAt: null,
        rolledBackAt: null,
        updatedAt: '2026-07-29T08:00:03.000Z',
      },
      {
        id: oldJobId,
        status: 'active',
        collection: oldCollection,
        embeddingProfile: 'combined:quality-v1',
        vectorDimension: 64,
        knowledgeFingerprint: 'fingerprint-v1',
        expectedCount: 128,
        completedCount: 128,
        checkpoint: 128,
        previousCollection: null,
        failureCode: null,
        createdBy: 'admin',
        createdAt: '2026-07-28T08:00:00.000Z',
        startedAt: '2026-07-28T08:00:01.000Z',
        readyAt: '2026-07-28T08:00:03.000Z',
        activatedAt: '2026-07-28T08:05:00.000Z',
        rolledBackAt: null,
        updatedAt: '2026-07-28T08:05:00.000Z',
      },
    ];

    await page.route('**/api/admin/retrieval/**', async (route) => {
      if (failRequests) {
        await route.fulfill({ status: 503, json: { code: 503, data: null, message: 'unavailable' } });
        return;
      }
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path.endsWith('/status')) {
        await route.fulfill({ json: { code: 0, data: {
          provider: 'qdrant',
          qdrantConfigured: true,
          qdrantHealth: 'healthy',
          alias: 'resolveweave_knowledge_active',
          collection: currentCollection,
          points: 128,
          dimensions: 64,
          syncStatus: 'synced',
        }, message: 'ok' } });
        return;
      }
      if (path.endsWith(`/index-jobs/${nextJobId}/activation-check`)) {
        await route.fulfill({ json: { code: 0, data: {
          eligible: true,
          reasons: [],
          warnings: ['p95_latency_regression_gt_25_percent'],
          qualityRunId: '33333333-3333-4333-8333-333333333333',
          candidateKey: `qdrant:${nextJobId}:policy`,
        }, message: 'ok' } });
        return;
      }
      if (path.endsWith(`/index-jobs/${nextJobId}/activate`)) {
        expect(request.postDataJSON()).toMatchObject({
          expectedCurrentCollection: oldCollection,
          confirmed: true,
          confirmLatencyWarning: true,
        });
        currentCollection = nextCollection;
        jobs = jobs.map((job) => (
          job.id === nextJobId
            ? {
                ...job,
                status: 'active',
                previousCollection: oldCollection,
                activatedAt: '2026-07-29T08:10:00.000Z',
              }
            : {
                ...job,
                status: 'rolled_back',
                rolledBackAt: '2026-07-29T08:10:00.000Z',
              }
        ));
        await route.fulfill({ json: { code: 0, data: jobs[0], message: 'ok' } });
        return;
      }
      if (path.endsWith(`/index-jobs/${nextJobId}/rollback`)) {
        expect(request.postDataJSON()).toMatchObject({
          expectedCurrentCollection: nextCollection,
          confirmed: true,
        });
        currentCollection = oldCollection;
        jobs = jobs.map((job) => (
          job.id === nextJobId
            ? {
                ...job,
                status: 'rolled_back',
                rolledBackAt: '2026-07-29T08:12:00.000Z',
              }
            : {
                ...job,
                status: 'active',
                rolledBackAt: null,
                activatedAt: '2026-07-29T08:12:00.000Z',
              }
        ));
        await route.fulfill({ json: { code: 0, data: jobs[1], message: 'ok' } });
        return;
      }
      if (path.endsWith('/index-jobs')) {
        await route.fulfill({ json: { code: 0, data: {
          items: jobs,
          total: jobs.length,
          page: 1,
          pageSize: 50,
        }, message: 'ok' } });
        return;
      }
      if (path.endsWith('/traces')) {
        await route.fulfill({ json: { code: 0, data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
        }, message: 'ok' } });
        return;
      }
      await route.fallback();
    });

    await page.getByText('质量实验室').click();
    await page.getByText('实验运行').click();
    await page.getByTitle('内存基线').click();
    await expect(page.getByText(`Qdrant 索引 · ${nextCollection}`)).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.getByText('登录成功').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-quality-backends.png',
        fullPage: true,
      });
    }
    await page.keyboard.press('Escape');

    await page.getByText('检索运维').click();
    await expect(page.getByText(nextCollection)).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.getByText('登录成功').waitFor({ state: 'hidden' });
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-index-ready.png',
        fullPage: true,
      });
    }

    const nextRow = page.locator('tr').filter({ hasText: nextCollection });
    await nextRow.getByRole('button', { name: '激活' }).click();
    await expect(page.getByText('Quality Lab 门禁已通过，可以原子切换 alias。')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认' })).toBeDisabled();
    await page.getByText('我已确认 P95 延迟警告并继续激活').click();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.waitForTimeout(350);
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-activation-gate.png',
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: '确认' }).click();
    await expect(nextRow).toContainText('已激活');
    await expect(page.getByText(nextCollection).first()).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-index-active.png',
        fullPage: true,
      });
    }

    await nextRow.getByRole('button', { name: '回滚' }).click();
    await expect(page.getByText(`Alias 将切回已验证 collection：${oldCollection}`)).toBeVisible();
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText(oldCollection).first()).toBeVisible();
    await expect(nextRow).toContainText('已回滚');
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-index-rolled-back.png',
        fullPage: true,
      });
    }

    failRequests = true;
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('检索运维数据加载失败，请重试。')).toBeVisible();
    if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
      await page.screenshot({
        path: 'docs/releases/assets/v0.3.2-ops-error.png',
        fullPage: true,
      });
    }
  });
});
