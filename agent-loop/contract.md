# Contract: v0.2.2 Acceptance Fixes

## Goal

Resolve the acceptance issues found during manual testing: FAQ answers should be predictable in local open-source runs, fixed UI copy should come from an editable bilingual dictionary, and the customer chat should expose lightweight history for the current anonymous browser user.

## Scope

- Keep v0.2.0 hybrid retrieval behavior, but make exact/high-confidence FAQ matches usable without relying on LLM free-form generation.
- Provide a local deterministic LLM/embedding fallback when no API key is configured, so open-source demo runs do not fail with opaque OpenAI errors.
- Move fixed frontend copy from hardcoded TypeScript objects into a bilingual editable dictionary file.
- Replace the main user-visible hardcoded frontend messages with dictionary keys.
- Add a lightweight chat history list for the current anonymous browser user, backed by existing conversation data.
- Preserve admin auth boundaries and avoid adding account or multi-tenant scope.

## Non-Goals

- No external vector database.
- No full i18n CMS, runtime dictionary editor, or database-backed translation management.
- No authenticated customer account system.
- No broad UI redesign beyond the new history affordance and copy wiring.
- No deployment, push, or release action.

## Done Check

- [ ] Querying a newly added FAQ by exact keyword/question returns the FAQ answer predictably in local demo mode.
- [ ] `EMBED_PROVIDER=other` plus no external API key does not cause chat to fail solely because OpenAI is unavailable.
- [ ] FAQ SSE metadata preserves `source`, `vectorScore`, and `keywordScore`.
- [ ] Frontend fixed copy is sourced from an editable bilingual dictionary.
- [ ] Main user-visible hardcoded Chinese/English messages in client code are replaced with `t(...)`.
- [ ] Customer chat exposes history sessions and can load a previous session for the same anonymous browser user.
- [ ] New UI text is covered in both `zh` and `en` dictionary entries.
- [ ] Regression tests pass.
- [ ] Production build passes.
- [ ] Evaluator records remaining risks or confirms none found in `agent-loop/progress.md`.

## Verification

- Run `EMBED_PROVIDER=other npm test`.
- Run `EMBED_PROVIDER=other npm run build`.
- Run `git diff --check`.
- Manual/browser checks:
  - Add or edit an active FAQ containing `FAQ测试`, rebuild index, ask `FAQ测试`, and confirm the answer comes from that FAQ.
  - Toggle Chinese/English and dark/light on chat and admin pages; fixed copy should switch consistently.
  - Send multiple messages, refresh, open history, and load the previous session.
  - No console errors, layout overlap, or unreadable dark-mode text in the changed surfaces.

## Execution Rules

- Generator must update `agent-loop/progress.md` before and after each major area.
- Keep changes scoped to the reported acceptance issues.
- Prefer simple repo-local JSON dictionary over a heavier i18n framework.
- Evaluator must review against this contract after generator work and must not rely only on generator claims.

## Stop Conditions

- The implementation would require replacing the UI framework or adding external services.
- The work requires account actions, posting, payment, deletion, or external deployment.
- Browser verification is blocked; continue with build/test/static review, but record the limitation.
- Three consecutive execution attempts fail for the same reason.

---

# Addendum: v0.2.3 Automation Baseline

## Goal

Add a durable Web + API automation baseline that covers normal flows, boundary values, and exception paths for the current open-source MVP.

## Scope

- Playwright configuration with isolated app/API ports and isolated SQLite test DB.
- API E2E coverage for health, auth, admin FAQ auth/validation, FAQ CRUD/index/search, chat SSE, satisfaction boundaries, and user-scoped history.
- Web E2E coverage for chat FAQ answers, left-side history, new chat, language/theme toggles, admin login failure/success, FAQ index status, and rebuild entry.
- Static regression checks to ensure E2E config, scripts, and key specs are not accidentally removed.
- Configurable login rate limit with the production default unchanged.

## Done Check

- [x] `EMBED_PROVIDER=other npm test` passes.
- [x] `npm run test:e2e` passes.
- [x] `EMBED_PROVIDER=other npm run build` passes.
- [x] `git diff --check` passes.
- [x] Remaining risks are recorded in `agent-loop/progress.md`.
