# Smart Customer Service AI

> Open-source AI customer service starter: chat, FAQ and document RAG, admin operations, evaluation, and debugging in one runnable project.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.16%2B%20%7C%2022.3%2B-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/Frontend-React%20%2B%20TDesign-0052d9.svg)](https://tdesign.tencent.com/react/overview)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-044a64.svg)](https://www.sqlite.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI_Compatible-10a37f.svg)](https://platform.openai.com/docs/api-reference)
[![Docker](https://img.shields.io/badge/Run-Docker-2496ed.svg)](Dockerfile)

**Chinese version**: [README_CN.md](README_CN.md)

Current version: **v0.2.7 (pre-1.0)**. APIs and persisted data remain subject to change before 1.0.

<p align="center">
  <a href="https://github.com/Rcloudso/smart-customer-service-ai/releases/download/v0.2.6/smart-customer-service-v0.2.6-demo.mp4">
    <img src="docs/demo/v0.2.6-preview.gif" width="880" alt="Smart Customer Service v0.2.6 document-grounded answer demo">
  </a>
</p>

<p align="center">
  <a href="https://github.com/Rcloudso/smart-customer-service-ai/releases/download/v0.2.6/smart-customer-service-v0.2.6-demo.mp4">Watch the latest public product demo (v0.2.6)</a>
  · <a href="docs/case-studies/ai-assisted-development-v0.2.6.md">AI-assisted development case study</a>
  · <a href="docs/releases/v0.2.7-evidence.md">v0.2.7 release evidence</a>
</p>

## English

Smart Customer Service AI is a full-stack demo for building an AI-assisted support system. It combines customer chat, FAQ and document knowledge management, hybrid retrieval, runtime model configuration, conversation analytics, bilingual UI, light/dark themes, and retrieval evaluation tooling.

[Quick Start](#quick-start) · [Features](#features) · [Architecture](ARCHITECTURE.md) · [Retrieval Design](#retrieval-design) · [Evaluation](#evaluation-and-debugging) · [Docker](#docker)

---

## What It Does

Type a customer question, and the system runs a support flow:

```text
User: How can I request a refund?

Smart Customer Service AI:
  Step 1: classify the question intent
  Step 2: retrieve related FAQ entries and document chunks with hybrid search
  Step 3: decide whether evidence supports a direct answer, generation, or refusal
  Step 4: answer with persisted sources, or escalate high-risk/conflicting requests
```

Admins can maintain FAQs, upload and manage documents, preview indexed chunks, inspect retrieval behavior, review conversations, and turn weak answers into reusable FAQs from the Knowledge Review page.

This project is designed for demos, learning, and small open-source MVPs that need a clear customer-support foundation without introducing a dedicated vector database on day one.

### Product evidence

| Document-grounded chat | Document operations | Mobile dark theme |
| --- | --- | --- |
| ![Chat answer with document and chunk provenance](docs/releases/assets/v0.2.6-chat-document-source.png) | ![Document status and chunk inspection](docs/releases/assets/v0.2.6-document-rag-demo.png) | ![Responsive English document workflow in dark theme](docs/releases/assets/v0.2.6-documents-mobile-dark.png) |

---

## Features

- **Customer chat experience** - streaming-style support UI with safe Markdown rendering, conversation context, compact document references, feedback, and history.
- **Answer-evidence policy** - choose deterministic FAQ, retrieval-supported generation, or refusal before answer generation; persist the decision and retrieved sources.
- **Admin console** - FAQ management, conversation list, dashboard analytics, and runtime model configuration.
- **Knowledge gap feedback loop** - no-match, low-score, and negatively rated answers become review items that admins can edit, dismiss, or convert into indexed FAQs.
- **Document RAG foundation** - upload TXT, Markdown, text-layer PDF, and DOCX files; parse, semantically chunk, embed, index, retry, enable/disable, preview, and delete them from the admin console.
- **Hybrid multi-source retrieval** - FAQ and document candidates use per-source vector recall plus field-aware keyword recall, then merge with score-aware reciprocal-rank fusion (RRF), deduplicate, and apply source-aware diversity.
- **Compatible intent classification** - structured intent output negotiates `json_schema`, then `json_object`, then validated plain-text JSON before the deterministic keyword fallback.
- **Open vector-store interface** - `VectorStore` keeps the default deployment simple while leaving room for Qdrant or pgvector later.
- **Richer FAQ embeddings** - FAQ vectors are generated from question, answer, and keywords, not only the question.
- **Index operations** - admin users can inspect indexed entries, active entries, missing embeddings, dimensions, rebuild time, and index errors.
- **Retrieval debugging** - admin panel explains ranked matches, source, similarity, keyword score, vector score, and ranking reason.
- **Retrieval evaluation** - repeatable FAQ and document evals report ranking metrics, score/source distributions, failures, and semantic-v1 versus structure-only comparison.
- **Language switching and bilingual dictionary** - fixed UI copy is read from an editable Chinese/English dictionary instead of being hard-coded across pages.
- **Light/dark themes** - persisted theme preferences for both customer and admin workflows.
- **Open-source readiness** - Docker, docker-compose, GitHub Actions CI, Playwright E2E, and bilingual docs are included.

---

## Retrieval Design

The current retrieval flow is intentionally practical:

```text
Query
  |
  +-- per-source embedding candidates through VectorStore
  |
  +-- field-aware SQL LIKE keyword candidates and deterministic query expansion
  |
  +-- merge by namespaced knowledge id
  |
  +-- score-aware reciprocal-rank fusion (RRF), with source diversity
  |
  +-- return matches with similarity-compatible fields
```

The default generic `VectorStore<KnowledgeIndexItem>` implementation is in-memory. FAQ and document-chunk embeddings are serialized in SQLite, then loaded into the shared process index under `faq:<id>` and `document:<chunkId>` namespaces. Each stored vector carries an embedding profile derived from provider, model, endpoint, and input-schema version; stale profiles are rebuilt atomically before the process index is replaced. This keeps local setup dependency-free while preventing vectors from different model configurations from being silently mixed.

FAQ remains a knowledge-source adapter rather than the permanent RAG boundary. TXT, Markdown, text-layer PDF, and DOCX ingestion use `semantic-v1` chunking. Document embeddings include document and section titles, and catalogue-style GPU questions receive deterministic vocabulary expansion before lexical recall. Chat recalls FAQ and document candidates separately so one source cannot crowd out the other.

v0.2.7 evaluates answer evidence before generation. High-confidence keyword/hybrid FAQ matches remain deterministic; non-direct evidence that clears the initial retrieval threshold can enter the model prompt as at most three untrusted excerpts. Missing or weak evidence is refused without calling the answer-generation stream. Duplicate direct FAQs with materially different answers and recognized private-state/action requests are refused and escalated. The answer mode, threshold result, reason, and compact FAQ/document/chunk/page source snapshots are saved with the assistant message and survive history restoration. These are retrieved sources, not claim-level citation or entailment verification.

`FaqMatch` keeps the existing `similarity` field for compatibility and adds optional debugging fields:

- `source`: `vector`, `keyword`, or `hybrid`
- `keywordScore`
- `vectorScore`
- `fusionScore`, `keywordRank`, and `vectorRank`

---

## Quick Start

Use Node.js 20.16+ or 22.3+.

```bash
npm install
cp .env.example .env
npm run db:init
npm run db:seed
EMBED_PROVIDER=other npm run dev
```

Open:

- Customer chat: http://localhost:5173/
- Admin console: http://localhost:5173/admin

Default local admin account:

```text
Username: admin
Password: admin123
```

Change `ADMIN_PASSWORD` before any production-like deployment. The server blocks the default password when `NODE_ENV=production`.

---

## Docker

```bash
docker compose up --build
```

Docker exposes:

- Frontend: http://localhost:5173/
- Backend health check: http://localhost:3001/api/health

The compose example uses `EMBED_PROVIDER=other`, so the project can start without paid model keys. The deterministic local path supports FAQ and document retrieval; document answers fall back to the highest-ranked source excerpt instead of inventing a summary.

---

## Configuration

Copy `.env.example` to `.env`, then configure the values you need:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Token signing secret |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Local admin account |
| `LLM_PROVIDER` / `EMBED_PROVIDER` | `openai`, `openai-compatible`, or `other` |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | Chat model endpoint, environment-only credential, and model |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | OpenAI-compatible embedding model |
| `DOCUMENT_UPLOAD_DIR` | Private document file directory; defaults to `./data/uploads` |
| `RATE_LIMIT_CHAT` / `RATE_LIMIT_ADMIN` / `RATE_LIMIT_LOGIN` | API rate limits |
| `SESSION_INACTIVITY_MINUTES` | Minutes without activity before an active conversation is closed; defaults to `30` |
| `CONVERSATION_EXPORT_MAX_MESSAGES` | Maximum complete message rows in one synchronous filtered CSV export; defaults to `5000` |

The environment is the source of truth for model configuration. The admin model page reads provider, endpoint, and model name from the environment and atomically writes non-secret edits back to the local `.env` file so they take effect immediately. Legacy `model_configs` rows in SQLite no longer override these values. The `openai` provider always uses `https://api.openai.com/v1`; custom API Base URLs are used only by `openai-compatible` and `other`. The admin API exposes only whether a key is configured and never accepts, returns, or rewrites key material; inject keys through environment variables or deployment secrets. In container or managed deployments where environment variables are externally injected or the filesystem is read-only, update the deployment secret/configuration and redeploy instead.

---

## Evaluation And Debugging

Run the repeatable FAQ retrieval benchmark:

```bash
EMBED_PROVIDER=other npm run eval:faq
EMBED_PROVIDER=other npm run eval:document
```

The reports include FAQ Top1/Top3/no-match metrics and a 12-case document benchmark across TXT, Markdown, PDF, and DOCX. The document report compares `semantic-v1` with a structure-only baseline and requires 100% Top3 recall without MRR regression.

Document management is available at **Admin Console → Documents**. Uploads are limited to 10 MB, extracted text to 200,000 characters, semantic units to 2,000, and final chunks to 300. Exact duplicate content is rejected by SHA-256; storage paths, hashes, embeddings, and parser exceptions are not returned by the API.

The FAQ report includes:

- Top1 accuracy
- Top3 recall
- No-match accuracy
- Result source distribution
- Failed cases with expected and actual matches

Admins can also use the FAQ management page to run a live retrieval debug query. The debug response explains what matched, how it ranked, and whether the match came from vector search, keyword fallback, or both.

### Knowledge Review Workflow

1. A completed answer with no FAQ match or a top retrieval score below `0.55` is saved as a pending review item. A 1–2 star rating also creates or updates the item for that exact answer.
2. Open **Admin Console → Knowledge Review** to inspect the question, answer, intent, rating, and the top three retrieval results captured at answer time.
3. Edit the proposed question, answer, category, and keywords, then convert the item to an FAQ. Successful conversion updates the semantic index automatically.
4. Ask the same question again to confirm the new FAQ is retrieved. Items with no reusable value can be dismissed with an optional reason.

Explicit “transfer to human” requests remain in the escalation workflow and are not automatically treated as knowledge gaps.

Satisfaction ratings remain backward compatible: clients may rate an exact assistant reply by `messageId` (optionally verified against `sessionId`), while legacy session-only requests rate the latest assistant reply in that session.

---

## Validation

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run eval:faq
EMBED_PROVIDER=other npm run eval:document
PLAYWRIGHT_CHANNEL=chromium npm run test:e2e
EMBED_PROVIDER=other npm run build
```

GitHub Actions runs `npm ci`, regression tests, Playwright E2E, and production build checks on pull requests and pushes to `main`.

---

## Project Layout

```text
client/        React + Vite frontend
server/        Express API, services, AI adapters, SQLite repositories
eval/          FAQ and document retrieval evaluation cases
tests/e2e/     Playwright end-to-end tests
ARCHITECTURE.md Runtime topology, trust boundaries, and scaling triggers
data/          Local SQLite database files
```

---

## Current Limits

- The default vector index is process-local memory and scans FAQ plus document-chunk embeddings, so it is suitable for demos and small knowledge collections.
- Embeddings are stored as JSON in SQLite, not in a dedicated vector database.
- Document parsing is synchronous inside the Express process. Encrypted, damaged, and scanned PDFs fail with a stable failure code; OCR, image knowledge, web ingestion, citation links, and page jumps are not included.
- Document files are global to the deployment; v0.2.7 does not add tenant-separated knowledge bases, background workers, document versioning, or external vector storage.
- `VectorStore` isolates local vector operations, but a network vector database still requires asynchronous contracts, health handling, and consistency tests.
- Conflict detection is deliberately narrow: duplicate normalized direct-FAQ questions with different answers. Initial grounding thresholds will be calibrated in v0.2.8.
- Intent classification falls back to keyword rules when the LLM call fails.
- This is a pre-1.0 MVP foundation, not a production support platform. Add observability, stricter auth, backup strategy, and external vector storage before serious production use.

---

## Roadmap

The ordered version plan lives in [ROADMAP.md](ROADMAP.md). The next milestones are:

- v0.2.8: versioned retrieval-quality experiments, thresholds, failure cases and optional reranking.
- v0.2.9: structured escalation packets with validated priority and support-queue routing.
- v0.3.0–v0.3.2: read-only order/logistics tools first, then human collaboration, then confirmed and audited write actions such as refund requests.
- Later adapters: reviewed web ingestion, OCR/image knowledge, consent-based customer memory and a voice channel that reuses the same chat, retrieval, tool and escalation workflows.
- v0.4.0: multi-knowledge-base and tenant boundaries, RBAC, audit, migration, backup, monitoring and evidence-driven external vector storage.

---

## 中文

Smart Customer Service AI 是一个开源 AI 智能客服 MVP，支持用户聊天、管理后台、FAQ 混合检索、检索评测、检索调试、中英文切换和暗/亮主题切换。完整中文说明请阅读 [README_CN.md](README_CN.md)。
