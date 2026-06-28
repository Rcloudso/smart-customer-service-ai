# Smart Customer Service AI

[English](README.md)

Smart Customer Service AI 是一个 AI 智能客服全栈示例项目，包含用户聊天页、管理后台、FAQ 管理、会话分析、模型配置、中英文切换和暗/亮主题切换。

### 功能特性

- 支持流式回复的 AI 客服对话。
- 支持退款、订单、技术、通用问题的意图识别。
- FAQ 检索支持轻量向量化，并在 embedding 不可用时回退到关键词匹配。
- 管理后台包含对话管理、FAQ 管理、数据概览和模型配置。
- 中英文切换，偏好会保存在浏览器本地。
- 暗/亮主题切换，偏好会保存在浏览器本地。
- 支持 FAQ CSV/JSON 导入和 CSV 导出。

### 架构说明

- 前端：React、Vite、TDesign React、Zustand。
- 后端：Express、TypeScript、SQLite、OpenAI 兼容的对话与 embedding 接口。
- 存储：SQLite 保存会话、消息、FAQ、配置覆盖项和序列化后的 embedding。
- 检索：当前使用进程内向量相似度计算；当 embedding 不可用时回退到 SQL LIKE 关键词检索。

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

管理后台的模型配置页可以把部分运行时模型配置覆盖保存到 SQLite。

### 验证命令

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run build
```

### 当前限制

- 当前向量索引在进程内存中，全量遍历 FAQ embedding，适合 Demo 和小规模 FAQ，不适合大规模检索。
- embedding 以 JSON 形式存储在 SQLite 中，没有使用专门的向量数据库。
- LLM 意图识别失败时会回退到关键词规则。
