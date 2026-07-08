# Smart Customer Service AI

> Open-source AI customer service starter: chat, FAQ retrieval, admin operations, evaluation, and debugging in one runnable project.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/Frontend-React%20%2B%20TDesign-0052d9.svg)](https://tdesign.tencent.com/react/overview)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-044a64.svg)](https://www.sqlite.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI_Compatible-10a37f.svg)](https://platform.openai.com/docs/api-reference)
[![Docker](https://img.shields.io/badge/Run-Docker-2496ed.svg)](Dockerfile)

**Chinese version**: [README_CN.md](README_CN.md)

## English

Smart Customer Service AI is a full-stack demo for building an AI-assisted support system. It combines a customer-facing chat page, FAQ knowledge management, hybrid retrieval, runtime model configuration, conversation analytics, bilingual UI, light/dark themes, and retrieval evaluation tooling.

[Quick Start](#quick-start) · [Features](#features) · [Retrieval Design](#retrieval-design) · [Evaluation](#evaluation-and-debugging) · [Docker](#docker)

---

## What It Does

Type a customer question, and the system runs a support flow:

```text
User: How can I request a refund?

Smart Customer Service AI:
  Step 1: classify the question intent
  Step 2: retrieve related FAQ entries with hybrid search
  Step 3: call the configured LLM for a natural-language answer
  Step 4: show references, confidence, and feedback controls
```

Admins can maintain FAQ entries, rebuild the FAQ index, inspect retrieval status, debug why a query matched a FAQ, and review conversations from the dashboard.

This project is designed for demos, learning, and small open-source MVPs that need a clear customer-support foundation without introducing a dedicated vector database on day one.

---

## Features

- **Customer chat experience** - streaming-style support UI with conversation context, references, feedback, and history.
- **Admin console** - FAQ management, conversation list, dashboard analytics, and runtime model configuration.
- **Hybrid retrieval** - in-memory vector similarity plus SQL keyword fallback, merged and ranked consistently.
- **Open vector-store interface** - `VectorStore` keeps the default deployment simple while leaving room for Qdrant or pgvector later.
- **Richer FAQ embeddings** - FAQ vectors are generated from question, answer, and keywords, not only the question.
- **Index operations** - admin users can inspect indexed entries, active entries, missing embeddings, dimensions, rebuild time, and index errors.
- **Retrieval debugging** - admin panel explains ranked matches, source, similarity, keyword score, vector score, and ranking reason.
- **Retrieval evaluation** - repeatable FAQ eval cases report Top1 accuracy, Top3 recall, no-match accuracy, and source distribution.
- **Language switching and bilingual dictionary** - fixed UI copy is read from an editable Chinese/English dictionary instead of being hard-coded across pages.
- **Light/dark themes** - persisted theme preferences for both customer and admin workflows.
- **Open-source readiness** - Docker, docker-compose, GitHub Actions CI, Playwright E2E, and bilingual docs are included.

---

## Retrieval Design

The current retrieval flow is intentionally practical:

```text
Query
  |
  +-- embedding search through VectorStore
  |
  +-- SQL LIKE keyword fallback
  |
  +-- merge by FAQ id
  |
  +-- rank hybrid > vector score > keyword score
  |
  +-- return matches with similarity-compatible fields
```

The default `VectorStore` implementation is in-memory. FAQ embeddings are serialized in SQLite, then loaded into the process index. This keeps local setup dependency-free while making the future vector database boundary explicit.

`FaqMatch` keeps the existing `similarity` field for compatibility and adds optional debugging fields:

- `source`: `vector`, `keyword`, or `hybrid`
- `keywordScore`
- `vectorScore`

---

## Quick Start

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

The compose example uses `EMBED_PROVIDER=other`, so the project can start without a real embedding key. When embeddings are unavailable, FAQ retrieval still has the SQL keyword fallback.

---

## Configuration

Copy `.env.example` to `.env`, then configure the values you need:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Token signing secret |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Local admin account |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI-compatible chat model |
| `EMBED_PROVIDER` | Embedding mode, use `other` for local fallback |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | OpenAI-compatible embedding model |
| `RATE_LIMIT_CHAT` / `RATE_LIMIT_ADMIN` / `RATE_LIMIT_LOGIN` | API rate limits |

Selected runtime model settings can also be overridden from the admin model configuration page and persisted in SQLite.

---

## Evaluation And Debugging

Run the repeatable FAQ retrieval benchmark:

```bash
EMBED_PROVIDER=other npm run eval:faq
```

The report includes:

- Top1 accuracy
- Top3 recall
- No-match accuracy
- Result source distribution
- Failed cases with expected and actual matches

Admins can also use the FAQ management page to run a live retrieval debug query. The debug response explains what matched, how it ranked, and whether the match came from vector search, keyword fallback, or both.

---

## Validation

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run eval:faq
npm run test:e2e
EMBED_PROVIDER=other npm run build
```

GitHub Actions runs `npm ci`, regression tests, Playwright E2E, and production build checks on pull requests and pushes to `main`.

---

## Project Layout

```text
client/        React + Vite frontend
server/        Express API, services, AI adapters, SQLite repositories
eval/          FAQ retrieval evaluation cases
tests/e2e/     Playwright end-to-end tests
data/          Local SQLite database files
```

---

## Current Limits

- The default vector index is process-local memory and scans FAQ embeddings, so it is suitable for demos and small FAQ collections.
- Embeddings are stored as JSON in SQLite, not in a dedicated vector database.
- `VectorStore` is ready for future Qdrant or pgvector implementations, but the default deployment stays dependency-light.
- Intent classification falls back to keyword rules when the LLM call fails.
- This is an MVP foundation, not a production support platform. Add observability, stricter auth, backup strategy, and external vector storage before serious production use.

---

## Roadmap

- External vector-store adapters such as Qdrant or pgvector.
- Better retrieval datasets and threshold tuning.
- More admin analytics for unanswered questions and low-confidence responses.
- Role-based admin permissions.
- Import/export flows for larger FAQ collections.

---

## 中文

Smart Customer Service AI 是一个开源 AI 智能客服 MVP，支持用户聊天、管理后台、FAQ 混合检索、检索评测、检索调试、中英文切换和暗/亮主题切换。完整中文说明请阅读 [README_CN.md](README_CN.md)。
