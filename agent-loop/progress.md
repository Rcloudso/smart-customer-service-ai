# Progress

## Current State

- User manually tested the running app and reported three acceptance issues:
  - FAQ entry added as `FAQ测试` did not produce a predictable knowledge-base answer after index rebuild.
  - Chat page needs history conversations.
  - Multi-language coverage is incomplete; fixed UI copy should come from an editable bilingual dictionary instead of being hardcoded.
- Contract and feature list now target v0.2.2 acceptance fixes.
- Implementation completed:
  - Added local deterministic LLM/embedding fallback when no LLM API key is configured.
  - Changed high-confidence keyword FAQ matches to direct FAQ answers in chat SSE.
  - Fixed hybrid ranking so exact keyword matches are not truncated behind vector-only matches.
  - Added public user-scoped chat history API and chat-page left history sidebar.
  - Moved fixed frontend copy to `client/src/i18n/dictionary.json`.
  - Replaced main user-visible hardcoded client messages with dictionary keys.
- User requested ChatGPT-style placement for history. The chat page now has a left sidebar with New Chat and history sessions; the top history button/drawer was removed.

## Next Step

- Human acceptance testing on the running dev server.

## Done Check

- [x] Querying a newly added FAQ by exact keyword/question returns the FAQ answer predictably in local demo mode.
- [x] `EMBED_PROVIDER=other` plus no external API key does not cause chat to fail solely because OpenAI is unavailable.
- [x] FAQ SSE metadata preserves `source`, `vectorScore`, and `keywordScore`.
- [x] Frontend fixed copy is sourced from an editable bilingual dictionary.
- [x] Main user-visible hardcoded Chinese/English messages in client code are replaced with `t(...)`.
- [x] Customer chat exposes history sessions and can load a previous session for the same anonymous browser user.
- [x] Chat history is placed in the left sidebar with a new-chat entry point.
- [x] New UI text is covered in both `zh` and `en` dictionary entries.
- [x] Regression tests pass.
- [x] Production build passes.
- [x] Evaluator/adversarial review records remaining risks, if any.

## Remaining Risk

- Chat history is scoped by anonymous browser UUID, not a real authenticated customer identity. This is acceptable for MVP/demo, but not sufficient for production customer accounts.
- The dictionary is file-based JSON, not runtime editable through an admin UI. This matches the current open-source MVP scope.
- Build still prints the existing PostCSS module type warning; it does not block build or runtime.

## v0.2.3 Automation Baseline

- Added Playwright E2E configuration with isolated ports `5174/3101` and `./data/e2e-test.db`.
- Added API E2E coverage for health, login success/failure, admin auth, FAQ CRUD/index/search boundaries, wildcard escaping, chat SSE, satisfaction boundaries, and user-scoped history ownership.
- Added Web E2E coverage for chat FAQ answers, left-sidebar history restore, new chat, language/theme toggles, login failure/success, FAQ index status, and rebuild entry point.
- Added test-only selectors on stable UI controls where TDesign DOM would otherwise make tests brittle.
- Made login rate limit configurable with default `5`; E2E raises it to avoid API/Web login tests interfering with each other.
- Verification passed:
  - `EMBED_PROVIDER=other npm test`
  - `npm run test:e2e`
  - `EMBED_PROVIDER=other npm run build`
  - `git diff --check`

## v0.2.3 Remaining Risk

- Browser E2E requires permission to launch local Chrome in this Codex desktop environment.
- Playwright report and test-result artifacts are ignored, but previous local runs may leave files until cleaned by Playwright.
- Build still prints the existing PostCSS module type warning; it remains non-blocking.

## Open Questions

- None blocking.
