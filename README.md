# Smart Customer Service AI

[中文版本](README_CN.md)

## English

Smart Customer Service AI is an open-source full-stack demo for an AI-assisted customer support system. It includes a customer chat page, an admin console, FAQ management, conversation analytics, runtime model configuration, bilingual UI, and light/dark theme switching.

### v0.2.0 Highlights

- Hybrid retrieval: in-memory vector similarity plus SQL keyword fallback.
- FAQ embeddings are generated from question, answer, and keywords.
- Admin FAQ index status shows active entries, indexed entries, missing embeddings, dimensions, last rebuild time, and errors.
- Admin users can rebuild the FAQ index from the FAQ management page.
- Language switching between Chinese and English plus persisted light/dark theme preferences.
- Docker and GitHub Actions CI are included for open-source contributors.

### Architecture

- Frontend: React, Vite, TDesign React, Zustand.
- Backend: Express, TypeScript, SQLite, OpenAI-compatible chat and embedding APIs.
- Storage: SQLite stores conversations, messages, FAQ entries, runtime config overrides, and serialized embeddings.
- Search: `VectorStore` is an explicit interface. The default implementation is in-memory, so no external vector database is required.

### Local Quick Start

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

### Docker

```bash
docker compose up --build
```

Docker exposes:

- Frontend: http://localhost:5173/
- Backend API: http://localhost:3001/api/health

The compose file uses `EMBED_PROVIDER=other` so the app can run without a real embedding key. In that mode, FAQ retrieval falls back to keyword search when embeddings cannot be generated.

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
- `RATE_LIMIT_CHAT`
- `RATE_LIMIT_ADMIN`
- `RATE_LIMIT_LOGIN`

The admin model configuration page can override selected runtime model settings in SQLite.

### Validation

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run build
```

GitHub Actions runs `npm ci`, `EMBED_PROVIDER=other npm test`, and `EMBED_PROVIDER=other npm run build` on pull requests and pushes to `main`.

### Current Limits

- The default vector index is in process memory and scans FAQ embeddings, so it is suitable for demos and small FAQ collections.
- Embeddings are stored as JSON in SQLite, not in a dedicated vector database.
- `VectorStore` is ready for future Qdrant or pgvector implementations, but v0.2.0 intentionally keeps the default deployment dependency-free.
- Intent classification falls back to keyword matching when the LLM call fails.

## 中文

Smart Customer Service AI 是一个开源的 AI 智能客服全栈示例项目，包含用户聊天页、管理后台、FAQ 管理、会话分析、运行时模型配置、中英文切换和暗/亮主题切换。

### v0.2.0 重点

- 混合检索：进程内向量相似度 + SQL 关键词 fallback。
- FAQ embedding 文本由问题、回答和关键词共同生成。
- FAQ 管理页展示索引状态：启用条目、已索引条目、缺失 embedding、向量维度、上次重建时间和错误。
- 管理员可以在 FAQ 管理页重建索引。
- 提供 Docker 和 GitHub Actions CI，方便开源贡献者验证。

### 本地启动

```bash
npm install
cp .env.example .env
npm run db:init
npm run db:seed
EMBED_PROVIDER=other npm run dev
```

访问：

- 用户聊天页：http://localhost:5173/
- 管理后台：http://localhost:5173/admin

默认本地管理员账号：

- 用户名：`admin`
- 密码：`admin123`

任何接近生产的部署前，都必须修改 `ADMIN_PASSWORD`。

### Docker

```bash
docker compose up --build
```

Docker 默认暴露：

- 前端：http://localhost:5173/
- 后端健康检查：http://localhost:3001/api/health

Compose 示例使用 `EMBED_PROVIDER=other`，因此没有真实 embedding key 时也能运行；embedding 不可用时，FAQ 检索会回退到关键词匹配。

### 验证命令

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run build
```
