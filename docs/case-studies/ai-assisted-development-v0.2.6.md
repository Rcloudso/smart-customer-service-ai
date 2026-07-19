# AI-Assisted Development Case Study: v0.2.6 Document RAG

> 中文摘要：这个版本展示的不是“让 AI 一次生成一个客服 Demo”，而是如何由人确定产品边界和验收标准，再让 Codex 加速代码检索、垂直切片实现、测试、对抗性检查与发布证据整理。关键决策仍由项目负责人完成：先保证可信来源、无 Key 可运行、数据一致性和兼容性，再考虑 Agent、外部向量库或长期记忆。

## The problem

The project already had customer chat, FAQ retrieval, an admin console, analytics, model configuration, and a knowledge-review loop. The next useful step was not another chat interface. It was allowing a small support team to import real operating documents and answer from them without losing source traceability, local-first deployment, or existing FAQ behavior.

The release therefore needed to prove one complete workflow:

```text
upload -> validate -> parse -> chunk -> index -> retrieve -> answer with provenance
       -> review the evidence -> disable, retry, or delete consistently
```

## What shipped

v0.2.6 added:

- TXT, Markdown, text-layer PDF, and DOCX ingestion.
- Semantic document chunking with document and section metadata.
- FAQ and document hybrid retrieval with source-aware candidate recall.
- Compact document, chunk, and page provenance in chat and knowledge-review snapshots.
- Admin status, chunk inspection, enable/disable, retry, and delete workflows.
- Environment-only model credentials and atomic writeback for non-secret settings.
- Provider-compatible intent output negotiation: `json_schema`, then `json_object`, then validated text JSON, then deterministic keyword fallback.
- A deterministic no-key path that returns the best source excerpt instead of inventing a summary.

## How Codex was used

Codex acted as an implementation and verification partner, not the product owner.

1. **Context reconstruction** — inspected the route, service, repository, retrieval, client, and test boundaries before proposing changes.
2. **Vertical-slice planning** — turned the product goal into an observable upload-to-answer workflow with compatibility and failure-state acceptance criteria.
3. **Implementation acceleration** — helped update parsers, chunking, repositories, services, retrieval, API contracts, UI, and tests while preserving the existing architecture.
4. **Adversarial review** — checked authorization, file limits, unsafe prompt material, database/index consistency, SSE compatibility, and fresh-clone behavior.
5. **Evidence packaging** — ran focused regressions, retrieval evaluations, browser workflows, build checks, and documented known limits instead of reporting only that the feature “worked.”

## Decisions that stayed human

The important choices were product and risk decisions, not code-completion decisions:

- **Trust before autonomy.** Source provenance and refusal/escalation come before business actions.
- **One product, not a feature zoo.** FAQ and documents are knowledge adapters inside the same support workflow.
- **Local-first remains the default.** SQLite plus the in-memory `VectorStore` is enough for the measured scale; Qdrant or pgvector is deferred until evidence justifies the operational cost.
- **No-key behavior is a requirement.** A fresh clone must still retrieve knowledge and return deterministic source excerpts.
- **Credentials stay outside product data.** API keys are injected through environment or deployment secrets, never stored in SQLite or echoed to the browser.
- **Compatibility is a release boundary.** Existing SSE events, response envelopes, `similarity`, anonymous-session ownership, and FAQ behavior remain intact.
- **No speculative multi-agent layer.** A typed service workflow and explicit tools are easier to test and govern than a team of agents for the current problem.

## Problems caught during development

AI assistance was most valuable when it helped expose failures early:

- **Source crowd-out:** one knowledge type could occupy all retrieval slots. FAQ and document candidates are now recalled separately before source-aware fusion.
- **Embedding drift:** vectors from different provider/model/input profiles could be mixed silently. The stored embedding profile now triggers an atomic rebuild before replacing the process index.
- **Secret persistence risk:** admin model configuration previously had a path toward database-owned credentials. The environment is now authoritative, and the API exposes only configured status.
- **Provider format incompatibility:** some OpenAI-compatible models reject `json_schema`. Intent classification now degrades through validated formats before keyword fallback.
- **Native-module ABI mismatch:** local `better-sqlite3` binaries revealed that verification must use the Node runtime they were compiled against; this is documented instead of being mistaken for an application regression.
- **False confidence from a happy path:** the release covers parser failures, write rollback, retry, disable/delete consistency, prompt isolation, auth, privacy, and no-key behavior.

## Evidence, not vibes

The release evidence records:

- FAQ evaluation: 11 cases, Top1 100%, Top3 100%, no-match 100%.
- Document evaluation: 12 real-format cases, Top3 100%, semantic-v1 MRR 1.000 versus structure baseline 0.958.
- Playwright: 32 API and Chromium workflows passed.
- Regression, server/client TypeScript, production build, and `git diff --check` passed.
- A fresh `git archive` checkout completed `npm ci` and the production build under the verified local runtime.

See [the full v0.2.6 evidence package](../releases/v0.2.6-evidence.md) for commands, security checks, screenshots, and known limits.

## What was deliberately not built

- No external vector database without a demonstrated scale bottleneck.
- No multi-agent orchestration for deterministic routing and CRUD workflows.
- No automatic refund, payment, order mutation, or other business write action.
- No OCR or image understanding disguised as PDF support.
- No long-term customer memory before identity, consent, retention, and deletion controls exist.
- No claim that the project is production-ready for large enterprises.

Those exclusions are part of the engineering quality. They keep the public codebase small enough to understand while leaving explicit boundaries for future adapters.

## What an interviewer can inspect

- Product and architecture direction: the public [README](../../README.md) and [roadmap](../../ROADMAP.md).
- Document workflow: `server/services/document.service.ts`, document repositories/routes, and `client/src/pages/admin/DocumentManagementPage.tsx`.
- Retrieval design: `server/ai/knowledge-retriever.ts`, `server/ai/vector-store.ts`, and the retrieval evaluations.
- Compatibility and safety: chat SSE routes, intent-classifier tests, model-config security tests, and prompt-isolation tests.
- End-to-end proof: `tests/e2e/api.spec.ts`, `tests/e2e/web.spec.ts`, and the [v0.2.6 demo video](https://github.com/Rcloudso/smart-customer-service-ai/releases/download/v0.2.6/smart-customer-service-v0.2.6-demo.mp4).

## Takeaway

The useful “vibe-coding” skill is not producing more code per prompt. It is keeping an AI-assisted loop grounded in product intent, repository constraints, small verified changes, and honest evidence. v0.2.6 is meant to make that loop inspectable.
