# Admin Token Expiry Logout Design

## Goal

When an authenticated admin API request receives HTTP 401 because its stored JWT is invalid or expired, the frontend clears the complete local authentication state and returns the user to `/login`.

## Scope

- Apply the behavior to requests made through the shared admin API client.
- Trigger logout only when the failed request was sent with an authentication token.
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

`client/src/api/client.ts` will expose a small unauthorized-handler registration boundary. The shared response handler will receive whether the request carried a token. On HTTP 401 with a token, it invokes the registered handler before throwing the normal `ApiError`.

`client/src/hooks/useAuth.ts` will register an idempotent handler after creating the Zustand store. The handler calls the existing `logout()` action, which removes both local-storage keys and resets the store. This direction avoids importing the auth store from the API client and therefore avoids a circular dependency through `useAuth -> adminApi -> client`.

The login request also uses the shared API client, but it is sent without an authentication token. Invalid credentials can therefore continue returning 401 and displaying the existing login error without being treated as an expired authenticated session.

## Observable Flow

1. An authenticated admin request reads the stored token and sends it in `Authorization`.
2. The server responds with HTTP 401, such as `Invalid token`.
3. The shared API client invokes the registered unauthorized handler.
4. The auth store removes `auth_token` and `auth_user`, then marks the user unauthenticated.
5. The existing `AuthGuard` renders its `/login` redirect.
6. The API call still rejects with `ApiError`; no protected workflow continues with stale data.

## Error Boundaries

- A 401 without an attached token does not invoke logout.
- HTTP 403, validation errors, network failures, and provider failures do not invoke logout.
- Multiple concurrent 401 responses may invoke the handler more than once; the existing logout action is idempotent.
- Local-storage access failures remain ignored consistently with the existing auth store behavior.

## Verification

Use one behavior-first browser tracer bullet:

1. Log in as admin and confirm both auth keys exist.
2. Intercept a protected admin request and return HTTP 401 with `Invalid token`.
3. Trigger that request through the visible admin workflow.
4. Assert navigation to `/login` and removal of both auth keys.

Keep the existing wrong-password browser test as regression evidence that an unauthenticated login 401 still displays the error and remains on `/login`. Run the relevant focused test first, followed by the normal regression, E2E, build, and diff checks required by `AGENTS.md`.
