# Admin Token Expiry Logout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the complete frontend authentication state and return an admin to `/login` when a token-authenticated admin API request receives HTTP 401.

**Architecture:** The shared admin API client owns HTTP status interpretation and exposes one unauthorized-handler registration boundary. The Zustand auth store registers its existing idempotent `logout()` action without creating a reverse import from the API client, and the existing `AuthGuard` owns navigation.

**Tech Stack:** React 18, TypeScript, Zustand, Fetch API, React Router, Playwright.

## Global Constraints

- Trigger logout only for HTTP 401 responses whose request token still equals the current auth-store token.
- Clear `auth_token`, `auth_user`, and Zustand authentication state.
- Preserve the existing `ApiError` rejection after clearing authentication.
- Do not add JWT parsing, proactive timers, token refresh, backend changes, or new UI notifications.
- Do not log out for login failures without a token, HTTP 403, validation errors, network failures, or provider failures.
- Keep the running no-key local development path and existing admin routes compatible.

---

## File Map

- Modify `tests/e2e/web.spec.ts`: add the public browser behavior test for an expired/invalid stored token.
- Modify `client/src/api/client.ts`: register and invoke the centralized unauthorized handler for authenticated 401 responses across JSON, upload, and download helpers, with a per-request `auth: false` option for login.
- Modify `client/src/api/admin.ts`: send login without any stored authentication token.
- Modify `client/src/hooks/useAuth.ts`: register the existing Zustand `logout()` action with the API client.
- Modify `agent-loop/releases/v0.2.6/progress.md`, `log.md`, `handoff.md`, and `agent-loop/current.md`: record completion and verification locally; never stage these files.

### Task 1: Authenticated 401 Logout Tracer Bullet

**Files:**
- Modify: `tests/e2e/web.spec.ts`
- Modify: `client/src/api/client.ts`
- Modify: `client/src/api/admin.ts`
- Modify: `client/src/hooks/useAuth.ts`
- Modify locally only: `agent-loop/current.md`
- Modify locally only: `agent-loop/releases/v0.2.6/progress.md`
- Modify locally only: `agent-loop/releases/v0.2.6/log.md`
- Modify locally only: `agent-loop/releases/v0.2.6/handoff.md`

**Interfaces:**
- Consumes: `useAuth.getState().logout(): void`, existing `AuthGuard`, existing `ApiError`, and authenticated helpers in `client/src/api/client.ts`.
- Produces: `setUnauthorizedHandler(handler: (requestToken: string) => void): void` from `client/src/api/client.ts`.
- Produces: `post<T>(path: string, body?: unknown, options?: { auth?: boolean }): Promise<T>` with login calling `{ auth: false }`.

- [x] **Step 1: Write the failing browser test**

Add this test beside the existing admin login test in `tests/e2e/web.spec.ts`:

```ts
test('an authenticated 401 clears local auth state and returns to login', async ({ page }) => {
  await loginAsAdmin(page);
  await expect.poll(() => page.evaluate(() => ({
    token: localStorage.getItem('auth_token'),
    user: localStorage.getItem('auth_user'),
  }))).not.toEqual({ token: null, user: null });

  await page.getByText('FAQ管理').click();
  await expect(page).toHaveURL(/\/admin\/faq$/);
  await expect(page.getByRole('heading', { name: /FAQ\s*管理/ })).toBeVisible();

  await page.route('**/api/admin/stats/overview**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 401, data: null, message: 'Invalid token' }),
    });
  });

  await page.locator('.app-admin-sidebar').getByText('数据概览').click();

  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => page.evaluate(() => ({
    token: localStorage.getItem('auth_token'),
    user: localStorage.getItem('auth_user'),
  }))).toEqual({ token: null, user: null });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin PLAYWRIGHT_CHANNEL=chromium npx playwright test --project=web-chrome --grep "authenticated 401"
```

Expected: FAIL because the current API client throws `ApiError` but leaves `auth_token`, `auth_user`, and the authenticated Zustand state intact, so the page does not reach `/login`.

- [x] **Step 3: Add the API-client unauthorized boundary**

In `client/src/api/client.ts`, add the registration and shared status helper:

```ts
type UnauthorizedHandler = (requestToken: string) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

function handleUnauthorized(response: Response, requestToken: string | null): void {
  if (response.status === 401 && requestToken) {
    unauthorizedHandler?.(requestToken);
  }
}
```

Change `handleResponse` to accept `requestHadToken` and invoke `handleUnauthorized` before throwing:

```ts
async function handleResponse<T>(response: Response, requestToken: string | null): Promise<T> {
  handleUnauthorized(response, requestToken);

  if (response.status === 204) {
    return null as T;
  }

  let body: { code: number; data: T; message: string } | null = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      body = await response.json();
    } catch (err) {
      if (response.ok) {
        throw err;
      }
    }
  }

  if (!response.ok) {
    const message = body?.message || `HTTP ${response.status}`;
    const code = body?.code || response.status;
    throw new ApiError(response.status, code, message, body?.data);
  }

  if (body && body.data !== undefined) {
    return body.data as T;
  }

  return null as T;
}
```

In each authenticated helper, replace its final `handleResponse` call so it passes the token state captured when the request was sent:

```ts
// get
return handleResponse<T>(response, token);

// post
return handleResponse<T>(response, token);

// put
return handleResponse<T>(response, token);

// del
return handleResponse<T>(response, token);

// uploadFile
return handleResponse<T>(response, token);
```

Update `downloadBlob` before its existing export error:

```ts
if (!response.ok) {
  handleUnauthorized(response, token);
  throw new ApiError(response.status, response.status, t('common.exportFailed'));
}
```

- [x] **Step 4: Register the Zustand logout action**

In `client/src/hooks/useAuth.ts`, import the registration boundary separately from the admin API namespace:

```ts
import { setUnauthorizedHandler } from '../api/client';
```

After creating `useAuth`, register the existing action:

```ts
setUnauthorizedHandler((requestToken) => {
  const auth = useAuth.getState();
  if (auth.token === requestToken) {
    auth.logout();
  }
});
```

This registration happens after store creation and keeps `client.ts` independent of the auth store.

- [x] **Step 5: Run the focused test and verify GREEN**

Run the same focused Playwright command from Step 2.

Expected: PASS; `/login` is reached and both local-storage auth keys are null.

- [x] **Step 6: Run regression and release gates**

Run:

```bash
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin EMBED_PROVIDER=other npm test
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin EMBED_PROVIDER=other npm run eval:faq
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin EMBED_PROVIDER=other npm run eval:document
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin PLAYWRIGHT_CHANNEL=chromium npm run test:e2e
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin EMBED_PROVIDER=other npm run build
git diff --check
```

Expected: all commands pass; FAQ remains 11/11, document Top3 remains 12/12, and the Playwright total increases by one browser test.

- [x] **Step 7: Update local Agent Loop evidence**

Record the authenticated-401 behavior, focused RED/GREEN evidence, full gate results, exact Git state, and intentionally running development server in the v0.2.6 progress, log, handoff, and current files. Keep all `agent-loop/` files unstaged.

- [x] **Step 8: Commit only intended tracked files**

Inspect status, staged names, and staged diff, then run:

```bash
git add client/src/api/admin.ts client/src/api/client.ts client/src/hooks/useAuth.ts tests/e2e/web.spec.ts docs/superpowers/specs/2026-07-15-admin-token-expiry-logout-design.md docs/superpowers/plans/2026-07-15-admin-token-expiry-logout.md
git commit -m "fix: log out expired admin sessions"
```

Expected: one implementation commit containing the plan, public behavior test, API boundary, and auth registration; no Agent Loop or other local-only files are staged.
