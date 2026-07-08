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

    await page.getByTestId('login-username').locator('input').fill('admin');
    await page.getByTestId('login-password').locator('input').fill('wrong-password');
    const [wrongResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);
    expect(wrongResponse.status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('用户名或密码错误')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('login-password').locator('input').fill('admin123');
    const [successResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/auth/login')),
      page.getByRole('button', { name: '登录' }).click(),
    ]);
    expect(successResponse.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '管理后台' })).toBeVisible();
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
});
