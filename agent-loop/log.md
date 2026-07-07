# Log

## [2026-07-03 14:51] planner | initialized

- Created the Agent Loop scaffold.
- Waiting for the first project goal and contract confirmation.

## [2026-07-03 15:00] planner | v0.2.1 contract drafted

- Drafted `agent-loop/feature_list.json` for v0.2.1 UI optimization.
- Drafted `agent-loop/contract.md` with scope, non-goals, done checks, verification, execution rules, and stop conditions.
- Updated `agent-loop/progress.md` to wait for user confirmation before generator execution.

## [2026-07-03 15:08] generator | execution started

- User confirmed the proposed workflow and v0.2.1 direction.
- Generator mode started against `agent-loop/contract.md`.
- First slice: write UI regression checks, then implement shared visual foundation and layout polish.

## [2026-07-03 15:22] generator | shared UI foundation implemented

- Added UI regression checks for shared layout classes, responsive CSS, and chat/login class adoption.
- Implemented global app shell/page/chat/login classes in `client/src/index.css`.
- Applied shared layout classes to admin shell, dashboard, conversations, FAQ, model config, chat, chat input/bubbles, and login page.
- Replaced the chat empty-state emoji with a TDesign chat icon.
- Moved stat card and skeleton loading colors onto theme variables for dark/light consistency.
- Verification: `EMBED_PROVIDER=other npm test` passed after this slice.

## [2026-07-03 16:42] evaluator | done-check review

- Verified `EMBED_PROVIDER=other npm test` passed.
- Verified `EMBED_PROVIDER=other npm run build` passed.
- Verified `git diff --check` passed.
- Verified local dev server was stopped after attempted browser validation.
- Browser validation was attempted with `playwright-cli open http://localhost:5173/login`, but Playwright cache access was blocked by the sandbox; escalation was rejected by the local usage gate. Remaining risk recorded in `progress.md`.

## [2026-07-04 00:22] evaluator | browser acceptance failed

- Ran Playwright browser validation for login, dashboard, FAQ, chat, language/theme controls, and FAQ index status API.
- Functional checks passed: login worked, console errors were 0, FAQ index status returned 401 without auth and 200 with auth.
- UI acceptance failed: dark-mode TDesign components kept light/low-contrast styling, FAQ toolbar stacked vertically on desktop, mobile admin layout clipped the main content, and TDesign pagination/select text did not follow English mode.

## [2026-07-04 00:35] generator | ui acceptance repair started

- Root cause: app only applied custom `data-theme`, not TDesign `.dark`/`theme-mode`; routes were not wrapped in TDesign `ConfigProvider`; FAQ/conversation toolbars used TDesign `Space` around a custom flex row; mobile admin still kept a desktop sidebar shape.
- Repair in progress: wire TDesign locale/theme, replace toolbar `Space` wrappers with native responsive flex groups, add responsive table and mobile admin navigation CSS, and add static regression checks for these failures.

## [2026-07-04 12:45] evaluator | ui acceptance repair verified

- Verified `EMBED_PROVIDER=other npm test` passed after repair.
- Verified `EMBED_PROVIDER=other npm run build` passed after repair; the existing PostCSS module type warning remains non-blocking.
- Verified `git diff --check` passed.
- Playwright checks passed: login, English + dark mode, FAQ index status, FAQ desktop toolbar, conversation toolbar, TDesign English pagination/select text, and mobile FAQ admin layout.
- Evidence screenshots: `/private/tmp/smart-cs-faq-dark-fixed.png` and `/private/tmp/smart-cs-faq-mobile-fixed.png`.

## [2026-07-04 14:45] evaluator | adversarial review completed

- Security/regression: repair stayed on frontend theme/layout/i18n and static tests; no new admin API or auth bypass surface was added.
- Functionality: FAQ index status, table listing, login, language toggle, theme toggle, and conversation list remained usable in Playwright.
- Visual: dark mode no longer leaves TDesign table/form/menu surfaces in light mode; FAQ/conversation toolbars no longer collapse into a full vertical stack on desktop.
- Responsive: 390px admin FAQ page has no document-level horizontal overflow; table overflow is contained inside the table card.
- Remaining non-blocking risk: mobile admin navigation is horizontally scrollable rather than a dedicated drawer; this is acceptable for the repair slice but should be improved in a future UI iteration.
# v0.2.2 acceptance fix loop

- Started from manual testing feedback: FAQ exact test did not return a predictable FAQ answer, chat history is missing, and fixed copy is still partly hardcoded.
- Re-scoped `contract.md` and `feature_list.json` to v0.2.2 acceptance fixes.
- Implementation order: backend FAQ/local fallback, frontend bilingual dictionary, lightweight chat history, regression verification.
- Implemented local fallback client, direct FAQ answer short-circuit, score-first hybrid ranking, chat history APIs/UI, and JSON bilingual dictionary.
- Verified `FAQ测试` search returns the exact FAQ as `source=keyword` with score `0.95`.
- Verified chat SSE for `FAQ测试` emits token `已收到测试` and preserves FAQ metadata.
- Verified chat history list/detail APIs return the runtime check session for `anon-runtime-check`.
- Verification passed: `EMBED_PROVIDER=other npm test`, `EMBED_PROVIDER=other npm run build`, `git diff --check`.
- Follow-up UI feedback moved chat history from a top button/drawer to a left sidebar with New Chat and history sessions, matching the ChatGPT web layout direction.
- Re-verified after sidebar change: `EMBED_PROVIDER=other npm test`, `EMBED_PROVIDER=other npm run build`, `git diff --check`.

## [2026-07-06 17:50] generator/evaluator | v0.2.3 automation baseline completed

- Added Playwright config, isolated E2E DB setup, API E2E specs, and Web E2E specs.
- API automation covers health, auth success/failure, admin auth and validation, FAQ CRUD/index/search edge cases, wildcard escaping, chat SSE, satisfaction boundaries, and history ownership.
- Web automation covers customer chat FAQ answer, left history restore, new chat, language/theme switch, backend login failure/success, FAQ index status, and rebuild action.
- Added stable test ids for chat, preferences, login, and FAQ index controls where needed.
- Made `RATE_LIMIT_LOGIN` configurable; default remains `5`, E2E uses `500`.
- Verification passed: `EMBED_PROVIDER=other npm test`, `npm run test:e2e`, `EMBED_PROVIDER=other npm run build`, `git diff --check`.
