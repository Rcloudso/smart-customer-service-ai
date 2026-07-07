import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5174);
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run test:e2e:dev-server',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-123',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123',
      EMBED_PROVIDER: 'other',
      LLM_API_KEY: '',
      LLM_API_BASE: '',
      LLM_MODEL: '',
      EMBED_API_KEY: '',
      EMBED_API_BASE: '',
      EMBED_MODEL: '',
      DB_PATH: './data/e2e-test.db',
      PORT: String(apiPort),
      VITE_PORT: String(webPort),
      API_PROXY_TARGET: apiURL,
      ALLOWED_ORIGINS: baseURL,
      RATE_LIMIT_CHAT: '200',
      RATE_LIMIT_ADMIN: '500',
      RATE_LIMIT_LOGIN: '500',
    },
  },
  projects: [
    {
      name: 'api',
      testMatch: /api\.spec\.ts/,
      use: {
        baseURL: apiURL,
      },
    },
    {
      name: 'web-chrome',
      testMatch: /web\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
      },
    },
  ],
});
