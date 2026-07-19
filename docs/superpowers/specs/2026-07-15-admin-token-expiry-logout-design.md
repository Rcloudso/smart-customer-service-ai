# Admin Token Expiry Logout Design

## Goal

When an authenticated admin API request receives HTTP 401 because its stored JWT is invalid or expired, the frontend clears the complete local authentication state and returns the user to `/login`.

## Scope

- Apply the behavior to requests made through the shared admin API client.
- Trigger logout only when the failed request was sent with the same authentication token that is still active when the 401 is handled.
- Clear `auth_token`, `auth_user`, and the Zustand authentication state.
- Let the existing `AuthGuard` perform the redirect after authentication state becomes unauthenticated.
- Preserve the original `ApiError` so the failed request stops normally.

## Non-Goals

- No JWT `exp` parsing or proactive expiry timer.
- No token refresh or silent reauthentication.
- No backend authentication contract changes.
- No logout on HTTP 403 or other errors.
- No session-expired notification in this slice.

## Design

`client/src/api/client.ts` will expose a small unauthorized-handler registration boundary. The shared response handler will receive the exact token captured when the request was sent. On HTTP 401 with a token, it invokes the registered handler before parsing the response body or throwing the normal `ApiError`.

`client/src/hooks/useAuth.ts` will register an idempotent handler after creating the Zustand store. The handler compares the request token with the current store token and calls the existing `logout()` action only when they still match. This prevents a delayed 401 from an old request from clearing a newer login. The logout action removes both local-storage keys and resets the store. This direction avoids importing the auth store from the API client and therefore avoids a circular dependency through `useAuth -> adminApi -> client`.

The login request also uses the shared API client, but it explicitly sets `auth: false` and is sent without an authentication token even if stale local storage exists. Invalid credentials can therefore continue returning 401 and displaying the existing login error without being treated as an expired authenticated session.

## Observable Flow

1. An authenticated admin request reads the stored token and sends it in `Authorization`.
2. The server responds with HTTP 401, such as `Invalid token`.
3. The shared API client invokes the registered unauthorized handler with the request token before parsing the response body.
4. If that token still matches the current store token, the auth store removes `auth_token` and `auth_user`, then marks the user unauthenticated; a stale request token is ignored.
5. The existing `AuthGuard` renders its `/login` redirect.
6. The API call still rejects with `ApiError`; no protected workflow continues with stale data.

## Error Boundaries

- A 401 without an attached token does not invoke logout.
- Login requests never attach an existing token, so credential 401 responses cannot trigger session-expiry handling.
- A delayed 401 from an older token does not clear a newer authenticated session.
- A malformed or empty JSON error body does not bypass status-based logout and still follows the unified `ApiError` path.
- HTTP 403, validation errors, network failures, and provider failures do not invoke logout.
- Multiple concurrent 401 responses may invoke the handler more than once; the existing logout action is idempotent.
- Local-storage access failures remain ignored consistently with the existing auth store behavior.

## Verification

Use behavior-first browser coverage:

1. Log in as admin and confirm both auth keys exist.
2. Intercept a protected admin request and return HTTP 401 with `Invalid token`.
3. Trigger that request through the visible admin workflow.
4. Assert navigation to `/login` and removal of both auth keys.
5. Delay a request from token A, log in again with token B, then release token A's 401 and assert token B remains active.
6. Return a malformed JSON 401 and assert status-based logout still completes.
7. Return 401 from the CSV export/download branch and assert it follows the same logout behavior.

Keep the existing wrong-password browser test as regression evidence that an unauthenticated login 401 still displays the error and remains on `/login`. Run the relevant focused test first, followed by the normal regression, E2E, build, and diff checks required by `AGENTS.md`.
