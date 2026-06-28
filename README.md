# Smart Customer Service AI

[中文版本](README_CN.md)

Smart Customer Service AI is a full-stack demo for an AI-assisted customer support system. It includes a customer chat page, an admin console, FAQ management, conversation analytics, model configuration, bilingual UI, and light/dark theme switching.

### Features

- AI chat with streaming responses.
- Intent classification for refund, order, technical, and general questions.
- FAQ retrieval with lightweight embeddings and a keyword fallback.
- Admin dashboard for conversations, FAQ entries, statistics, and model settings.
- Language switching between Chinese and English.
- Light and dark theme switching with persisted preferences.
- CSV/JSON FAQ import and CSV export.

### Architecture

- Frontend: React, Vite, TDesign React, Zustand.
- Backend: Express, TypeScript, SQLite, OpenAI-compatible chat and embedding APIs.
- Storage: SQLite stores conversations, messages, FAQ entries, configuration overrides, and serialized embeddings.
- Search: in-process vector similarity for active FAQ embeddings, with SQL LIKE fallback when embeddings are unavailable.

### Quick Start

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

- Username: `admin`
- Password: `admin123`

Change `ADMIN_PASSWORD` before any production-like deployment.

### Configuration

Copy `.env.example` to `.env`, then configure:

- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `LLM_API_BASE`
- `LLM_API_KEY`
- `LLM_MODEL`
- `EMBED_PROVIDER`
- `EMBED_API_BASE`
- `EMBED_API_KEY`
- `EMBED_MODEL`

The admin model configuration page can override selected runtime model settings in SQLite.

### Validation

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run build
```

### Current Limits

- The vector index is in memory and scans all FAQ embeddings, so it is suitable for demos and small FAQ collections, not high-scale retrieval.
- Embeddings are stored as JSON in SQLite, not in a dedicated vector database.
- Intent classification falls back to keyword matching when the LLM call fails.
