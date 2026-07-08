# Smart Customer Service AI

> 开源 AI 智能客服 MVP：聊天、FAQ 检索、后台运营、检索评测和调试，一套项目直接跑起来。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/Frontend-React%20%2B%20TDesign-0052d9.svg)](https://tdesign.tencent.com/react/overview)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-044a64.svg)](https://www.sqlite.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI_Compatible-10a37f.svg)](https://platform.openai.com/docs/api-reference)
[![Docker](https://img.shields.io/badge/Run-Docker-2496ed.svg)](Dockerfile)

**English version**: [README.md](README.md)

Smart Customer Service AI 是一个 AI 智能客服全栈示例项目。它把用户聊天页、FAQ 知识库、混合检索、运行时模型配置、会话分析、中英文界面、暗/亮主题，以及 FAQ 检索评测工具放在同一个可运行工程里。

[快速开始](#快速开始) · [特性](#特性) · [检索设计](#检索设计) · [评测与调试](#评测与调试) · [Docker](#docker)

---

## 它能做什么

用户输入一个客服问题，系统会执行一条完整的智能客服链路：

```text
用户：我想申请退款

Smart Customer Service AI:
  Step 1: 识别问题意图
  Step 2: 用混合检索查找相关 FAQ
  Step 3: 调用配置好的 LLM 生成自然语言回答
  Step 4: 返回参考 FAQ、置信度和满意度反馈入口
```

管理员可以维护 FAQ、重建 FAQ 索引、查看索引状态、调试某个问题为什么命中了某条 FAQ，并在后台查看会话记录和基础数据看板。

这个项目适合 Demo、学习、开源 MVP 和小规模客服场景。它先保留 SQLite + 内存向量索引的低依赖方案，同时把未来接入向量数据库的接口边界留清楚。

---

## 特性

- **用户聊天体验** - 支持上下文对话、FAQ 参考、满意度反馈和历史会话。
- **管理后台** - FAQ 管理、会话列表、数据看板和运行时模型配置。
- **混合 FAQ 检索** - 进程内向量相似度 + SQL LIKE 关键词 fallback，统一合并、去重和排序。
- **向量库接口抽象** - `VectorStore` 让默认部署保持简单，也方便后续接入 Qdrant 或 pgvector。
- **更完整的 FAQ embedding** - embedding 文本由问题、回答和关键词共同组成，而不是只使用问题。
- **索引状态管理** - 后台展示启用条目、已索引条目、缺失 embedding、向量维度、上次重建时间和索引错误。
- **检索调试面板** - 后台可以查看命中条目、source、similarity、keywordScore、vectorScore 和排序原因。
- **检索评测能力** - 固定 FAQ 评测集输出 Top1 命中率、Top3 召回率、无匹配通过率和来源分布。
- **中英文词典** - 固定 UI 文案从可编辑的中英文词典读取，减少硬编码散落在组件里。
- **暗/亮主题切换** - 用户端和后台都支持持久化主题偏好。
- **开源工程化** - 提供 Docker、docker-compose、GitHub Actions CI、Playwright E2E 和中英文文档。

---

## 检索设计

当前检索链路刻意保持务实：

```text
Query
  |
  +-- 通过 VectorStore 做 embedding 相似度检索
  |
  +-- 通过 SQL LIKE 做关键词 fallback
  |
  +-- 按 FAQ id 合并去重
  |
  +-- 排序：hybrid > vector score > keyword score
  |
  +-- 返回兼容 similarity 字段的匹配结果
```

默认 `VectorStore` 是内存实现。FAQ embedding 会序列化存入 SQLite，服务启动或重建索引时加载到进程内索引中。这样本地启动不需要额外向量数据库，同时未来替换向量存储时边界也足够清楚。

`FaqMatch` 保留已有的 `similarity` 字段，避免破坏旧响应；同时新增可选调试字段：

- `source`: `vector`、`keyword` 或 `hybrid`
- `keywordScore`
- `vectorScore`

---

## 快速开始

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

默认本地管理员账号：

```text
用户名：admin
密码：admin123
```

任何接近生产的部署前，都必须修改 `ADMIN_PASSWORD`。当 `NODE_ENV=production` 时，服务端会拦截默认管理员密码。

---

## Docker

```bash
docker compose up --build
```

Docker 默认暴露：

- 前端：http://localhost:5173/
- 后端健康检查：http://localhost:3001/api/health

Compose 示例使用 `EMBED_PROVIDER=other`，所以没有真实 embedding key 时也能启动。embedding 不可用时，FAQ 检索仍然会走 SQL 关键词 fallback。

---

## 配置项

复制 `.env.example` 为 `.env`，然后按需配置：

| 变量 | 用途 |
| --- | --- |
| `JWT_SECRET` | JWT 签名密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 本地管理员账号 |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容对话模型 |
| `EMBED_PROVIDER` | embedding 模式，本地 fallback 可用 `other` |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | OpenAI 兼容 embedding 模型 |
| `RATE_LIMIT_CHAT` / `RATE_LIMIT_ADMIN` / `RATE_LIMIT_LOGIN` | API 限流配置 |

管理后台的模型配置页可以把部分运行时模型配置覆盖保存到 SQLite。

---

## 评测与调试

运行 FAQ 检索评测：

```bash
EMBED_PROVIDER=other npm run eval:faq
```

评测报告包含：

- Top1 命中率
- Top3 召回率
- 无匹配通过率
- 结果来源分布
- 失败用例的期望和实际命中

管理员也可以在 FAQ 管理页直接输入问题进行检索调试。调试结果会解释命中了什么、为什么排序靠前，以及来源是向量检索、关键词 fallback，还是二者共同命中。

---

## 验证命令

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run eval:faq
npm run test:e2e
EMBED_PROVIDER=other npm run build
```

GitHub Actions 会在 PR 和推送到 `main` 时运行 `npm ci`、回归测试、Playwright E2E 和生产构建检查。

---

## 项目结构

```text
client/        React + Vite 前端
server/        Express API、服务层、AI 适配器、SQLite 仓储
eval/          FAQ 检索评测用例
tests/e2e/     Playwright 端到端测试
data/          本地 SQLite 数据库文件
```

---

## 当前限制

- 默认向量索引在进程内存中，全量遍历 FAQ embedding，适合 Demo 和小规模 FAQ，不适合大规模检索。
- embedding 以 JSON 形式存储在 SQLite 中，没有使用专门的向量数据库。
- `VectorStore` 已为未来接入 Qdrant 或 pgvector 留出接口，但默认部署仍保持低依赖。
- LLM 意图识别失败时会回退到关键词规则。
- 这是一个 MVP 基座，不是完整生产客服平台。正式生产前应补充可观测性、更严格的鉴权、备份策略和外部向量存储。

---

## Roadmap

- 接入 Qdrant 或 pgvector 等外部向量库适配器。
- 扩展检索评测数据集和阈值调优能力。
- 增加未回答问题、低置信度回复等后台分析。
- 增加后台角色权限。
- 支持更大规模 FAQ 的导入、导出和批处理。
