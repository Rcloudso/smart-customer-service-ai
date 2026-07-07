# Smart Customer Service AI

[English](README.md)

Smart Customer Service AI 是一个开源的 AI 智能客服全栈示例项目，包含用户聊天页、管理后台、FAQ 管理、会话分析、模型配置、中英文切换和暗/亮主题切换。

### v0.2.0 重点

- 混合检索：进程内向量相似度 + SQL LIKE 关键词 fallback。
- FAQ embedding 文本由问题、回答和关键词共同生成，而不是只使用问题。
- FAQ 管理页展示索引状态：启用条目、已索引条目、缺失 embedding、向量维度、上次重建时间和错误。
- 管理员可以在 FAQ 管理页手动重建索引。
- 新增 Docker、docker-compose 和 GitHub Actions CI，方便开源贡献者验证项目。

### 架构说明

- 前端：React、Vite、TDesign React、Zustand。
- 后端：Express、TypeScript、SQLite、OpenAI 兼容的对话与 embedding 接口。
- 存储：SQLite 保存会话、消息、FAQ、配置覆盖项和序列化后的 embedding。
- 检索：`VectorStore` 是显式接口，默认实现为进程内内存向量库，不需要外部向量数据库。

### 快速启动

```bash
npm install
cp .env.example .env
npm run db:init
npm run db:seed
EMBED_PROVIDER=other npm run dev
```

访问地址：

- 用户聊天页：http://localhost:5173/
- 管理后台：http://localhost:5173/admin

本地默认管理员账号：

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

Compose 示例使用 `EMBED_PROVIDER=other`，因此没有真实 embedding key 时也能启动。embedding 不可用时，FAQ 检索会回退到关键词匹配。

### 配置项

复制 `.env.example` 为 `.env`，然后配置：

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

管理后台的模型配置页可以把部分运行时模型配置覆盖保存到 SQLite。

### 验证命令

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run build
```

GitHub Actions 会在 PR 和推送到 `main` 时运行 `npm ci`、`EMBED_PROVIDER=other npm test` 和 `EMBED_PROVIDER=other npm run build`。

### 当前限制

- 默认向量索引在进程内存中，全量遍历 FAQ embedding，适合 Demo 和小规模 FAQ，不适合大规模检索。
- embedding 以 JSON 形式存储在 SQLite 中，没有使用专门的向量数据库。
- `VectorStore` 已为未来接入 Qdrant 或 pgvector 留出接口，但 v0.2.0 默认不引入外部向量数据库依赖。
- LLM 意图识别失败时会回退到关键词规则。
