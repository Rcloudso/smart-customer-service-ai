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

    const input = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('chat-send-button');
    await expect(sendButton).toHaveClass(/t-is-disabled/);

    await input.fill('如何申请退款？');
    await expect(sendButton).not.toHaveClass(/t-is-disabled/);
    await sendButton.click();

    await expect(page.getByTestId('chat-messages')).toContainText('如何申请退款？');
    await expect(page.getByTestId('chat-messages')).toContainText('登录您的账户', { timeout: 15_000 });
    await expect(page.getByTestId('chat-messages')).toContainText('相关FAQ参考');

    const historyItem = page.getByTestId('chat-history-item').filter({ hasText: '如何申请退款？' }).first();
    await expect(historyItem).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('new-chat-button').click();
    await expect(page.getByTestId('chat-messages')).toContainText('您好，有什么可以帮您？');
    await expect(page.getByTestId('chat-messages')).not.toContainText('登录您的账户');

    await historyItem.click();
    await expect(page.getByTestId('chat-messages')).toContainText('如何申请退款？');
    await expect(page.getByTestId('chat-messages')).toContainText('登录您的账户');
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

    await page.getByRole('button', { name: '导出CSV' }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(requestAuthorization).toMatch(/^Bearer\s+\S+$/);
    await expect.poll(() => page.evaluate(() => ({
      token: localStorage.getItem('auth_token'),
      user: localStorage.getItem('auth_user'),
    }))).toEqual({ token: null, user: null });
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
    await expect(page.getByTestId('faq-debug-panel')).toBeVisible();

    const rebuildButton = page.getByTestId('faq-rebuild-index-button');
    await expect(rebuildButton).toBeVisible();
    await rebuildButton.click();
    await expect(page.getByText('FAQ索引已重建')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('faq-index-status')).toContainText('已索引');

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
      if (process.env.CAPTURE_RELEASE_EVIDENCE === '1') {
        await page.waitForTimeout(350);
        await page.screenshot({ path: 'docs/releases/assets/v0.2.6-document-detail.png', fullPage: true });
      }
      await page.getByRole('button', { name: '关闭' }).click();

      await page.getByTestId('language-toggle').click();
      await expect(page.getByRole('heading', { name: 'Document Knowledge' })).toBeVisible();
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
    } finally {
      if (documentId) {
        const deleted = await page.request.delete(`/api/admin/documents/${documentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleted.status()).toBe(200);
      }
    }
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
