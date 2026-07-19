# Smart Customer Service AI

> 开源 AI 智能客服 MVP：聊天、FAQ 与文档 RAG、后台运营、检索评测和调试，一套项目直接跑起来。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.16%2B%20%7C%2022.3%2B-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/Frontend-React%20%2B%20TDesign-0052d9.svg)](https://tdesign.tencent.com/react/overview)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-044a64.svg)](https://www.sqlite.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI_Compatible-10a37f.svg)](https://platform.openai.com/docs/api-reference)
[![Docker](https://img.shields.io/badge/Run-Docker-2496ed.svg)](Dockerfile)

**English version**: [README.md](README.md)

当前版本：**v0.2.6（pre-1.0）**。在 1.0 之前，API 和持久化数据结构仍可能调整。

Smart Customer Service AI 是一个 AI 智能客服全栈示例项目。它把用户聊天页、FAQ 与文档知识库、混合检索、运行时模型配置、会话分析、中英文界面、暗/亮主题，以及检索评测工具放在同一个可运行工程里。

[快速开始](#快速开始) · [特性](#特性) · [检索设计](#检索设计) · [评测与调试](#评测与调试) · [Docker](#docker)

---

## 它能做什么

用户输入一个客服问题，系统会执行一条完整的智能客服链路：

```text
用户：我想申请退款

Smart Customer Service AI:
  Step 1: 识别问题意图
  Step 2: 用混合检索查找相关 FAQ 和文档切片
  Step 3: 调用配置好的 LLM 生成自然语言回答
  Step 4: 返回参考 FAQ、置信度和满意度反馈入口
```

管理员可以维护 FAQ，上传和管理文档，预览已索引切片，查看检索行为与会话记录，并在“知识审核”页面把答不好的问题沉淀成可复用 FAQ。

这个项目适合 Demo、学习、开源 MVP 和小规模客服场景。它先保留 SQLite + 内存向量索引的低依赖方案，同时把未来接入向量数据库的接口边界留清楚。

---

## 特性

- **用户聊天体验** - 支持安全 Markdown 渲染、上下文对话、紧凑文档来源、FAQ 参考、满意度反馈和历史会话。
- **管理后台** - FAQ 管理、会话列表、数据看板和运行时模型配置。
- **知识缺口反馈闭环** - 无匹配、低检索分和 1–2 星负反馈会进入知识审核，管理员可编辑、忽略或转换为已索引 FAQ。
- **文档 RAG 基座** - 后台上传 TXT、Markdown、含文本层 PDF 和 DOCX，完成解析、语义切片、embedding、索引、重试、启停、预览和删除。
- **多知识源混合检索** - FAQ 与文档分别召回向量候选，再结合字段感知的关键词候选，由统一检索器通过分数感知的倒数排名融合（RRF）合并、去重并保持来源多样性。
- **兼容意图分类** - 结构化输出依次尝试 `json_schema`、`json_object` 和经过严格校验的普通文本 JSON，最后才降级到确定性关键词规则。
- **向量库接口抽象** - `VectorStore` 让默认部署保持简单，也方便后续接入 Qdrant 或 pgvector。
- **更完整的 FAQ embedding** - embedding 文本由问题、回答和关键词共同组成，而不是只使用问题。
- **索引状态管理** - 后台展示启用条目、已索引条目、缺失 embedding、向量维度、上次重建时间和索引错误。
- **检索调试面板** - 后台可以查看命中条目、source、similarity、keywordScore、vectorScore 和排序原因。
- **检索评测能力** - FAQ 和文档固定评测集输出排序指标、分数/来源分布、失败样例，以及 semantic-v1 与仅结构切片的对比。
- **中英文词典** - 固定 UI 文案从可编辑的中英文词典读取，减少硬编码散落在组件里。
- **暗/亮主题切换** - 用户端和后台都支持持久化主题偏好。
- **开源工程化** - 提供 Docker、docker-compose、GitHub Actions CI、Playwright E2E 和中英文文档。

---

## 检索设计

当前检索链路刻意保持务实：

```text
Query
  |
  +-- 通过 VectorStore 按知识来源召回 embedding 候选
  |
  +-- 通过字段感知的 SQL LIKE 和确定性查询扩展召回关键词候选
  |
  +-- 按带命名空间的知识 id 合并去重
  |
  +-- 通过分数感知的倒数排名融合（RRF）排序，并保持来源多样性
  |
  +-- 返回兼容 similarity 字段的匹配结果
```

默认泛型 `VectorStore<KnowledgeIndexItem>` 是内存实现。FAQ 与文档切片 embedding 会序列化存入 SQLite，再以 `faq:<id>` 和 `document:<chunkId>` 命名空间加载到共享进程索引。每条向量同时保存由 provider、模型、endpoint 和输入结构版本生成的 embedding profile；发现旧 profile 时先原子重建持久化向量，再替换进程索引，避免不同模型配置的向量被静默混用。

FAQ 仍然只是知识来源适配器，不是永久的 RAG 边界。v0.2.6 新增 TXT、Markdown、含文本层 PDF 与 DOCX 导入，以及 `semantic-v1` 语义切片。文档 embedding 包含文档标题和章节标题，GPU 型号清单类问题会在关键词召回前执行确定性词汇扩展。聊天会分别召回 FAQ 与文档候选，避免单一来源挤占全部结果，再最多把前三条不可信知识材料注入 Prompt；精确 FAQ 继续确定性直答，生成回答支持安全 Markdown，并可显示文档名、切片和页码等紧凑来源信息。无 LLM Key 时则返回最高分文档名和原文片段，不生成伪摘要。

`FaqMatch` 保留已有的 `similarity` 字段，避免破坏旧响应；同时新增可选调试字段：

- `source`: `vector`、`keyword` 或 `hybrid`
- `keywordScore`
- `vectorScore`
- `fusionScore`、`keywordRank` 和 `vectorRank`

---

## 快速开始

请使用 Node.js 20.16+ 或 22.3+。

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

Compose 示例使用 `EMBED_PROVIDER=other`，所以没有付费模型 Key 时也能启动。确定性本地路径支持 FAQ 与文档检索；文档回答会回退到最高分原文片段。

---

## 配置项

复制 `.env.example` 为 `.env`，然后按需配置：

| 变量 | 用途 |
| --- | --- |
| `JWT_SECRET` | JWT 签名密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 本地管理员账号 |
| `LLM_PROVIDER` / `EMBED_PROVIDER` | `openai`、`openai-compatible` 或 `other` |
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | 对话模型地址、仅环境注入的凭据和模型名 |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | OpenAI 兼容 embedding 模型 |
| `DOCUMENT_UPLOAD_DIR` | 私有文档文件目录，默认 `./data/uploads` |
| `RATE_LIMIT_CHAT` / `RATE_LIMIT_ADMIN` / `RATE_LIMIT_LOGIN` | API 限流配置 |
| `SESSION_INACTIVITY_MINUTES` | 活跃会话无消息后自动关闭的分钟数，默认 `30` |
| `CONVERSATION_EXPORT_MAX_MESSAGES` | 一次同步筛选 CSV 可导出的完整消息行上限，默认 `5000` |

环境变量是模型配置的唯一生效来源。管理后台模型配置页从环境读取服务商、地址和模型名，并把非敏感修改原子回写到本地 `.env`，当前进程会立即生效；SQLite 中历史 `model_configs` 数据不再覆盖环境配置。`openai` 服务商始终使用 `https://api.openai.com/v1`；只有 `openai-compatible` 和 `other` 使用自定义 API Base URL。管理接口只返回密钥是否已配置，不接收、不返回、不回写 API Key 内容；密钥必须通过环境变量或部署 Secret 注入。容器或托管环境若使用外部注入变量或只读文件系统，应修改部署配置并重新部署，而不是依赖后台写文件。

---

## 评测与调试

运行 FAQ 检索评测：

```bash
EMBED_PROVIDER=other npm run eval:faq
EMBED_PROVIDER=other npm run eval:document
```

评测包含 FAQ 的 Top1/Top3/无匹配指标，以及覆盖 TXT、Markdown、PDF、DOCX 的 12 条文档用例。文档评测会对比 `semantic-v1` 与仅结构切片基线，并要求 Top3 100%、MRR 不下降。

文档管理入口位于 **管理后台 → 文档知识**。单文件上限 10 MB、提取文本上限 200,000 字符、语义单元上限 2,000、最终切片上限 300。完全重复内容按 SHA-256 拒绝；接口不返回存储路径、哈希、embedding 或解析器原始异常。

FAQ 评测报告包含：

- Top1 命中率
- Top3 召回率
- 无匹配通过率
- 结果来源分布
- 失败用例的期望和实际命中

管理员也可以在 FAQ 管理页直接输入问题进行检索调试。调试结果会解释命中了什么、为什么排序靠前，以及来源是向量检索、关键词 fallback，还是二者共同命中。

### 知识审核使用流程

1. 一次回答完成后，如果没有 FAQ 结果或第一名检索分低于 `0.55`，系统会保存一条待审核记录；用户给该回答 1–2 星时也会针对同一问答轮次创建或更新记录。
2. 进入 **管理后台 → 知识审核**，查看用户问题、AI 回答、意图、评分，以及回答当时保存的前三条检索依据。
3. 编辑问题、回答、分类和关键词后转为 FAQ；转换成功会自动同步语义索引。
4. 再次提问同一问题，确认新 FAQ 已能命中。没有复用价值的记录可填写可选原因后忽略。

用户明确说“转人工/人工客服”时仍只进入现有转人工流程，不会因为检索结果自动进入知识审核。

满意度评分保持向后兼容：客户端可通过 `messageId` 精确评价某条助手回复，并可同时提交 `sessionId` 做归属校验；旧客户端只传 `sessionId` 时仍评价该会话最后一条助手回复。

---

## 验证命令

```bash
EMBED_PROVIDER=other npm test
EMBED_PROVIDER=other npm run eval:faq
EMBED_PROVIDER=other npm run eval:document
PLAYWRIGHT_CHANNEL=chromium npm run test:e2e
EMBED_PROVIDER=other npm run build
```

GitHub Actions 会在 PR 和推送到 `main` 时运行 `npm ci`、回归测试、Playwright E2E 和生产构建检查。

---

## 项目结构

```text
client/        React + Vite 前端
server/        Express API、服务层、AI 适配器、SQLite 仓储
eval/          FAQ 与文档检索评测用例
tests/e2e/     Playwright 端到端测试
data/          本地 SQLite 数据库文件
```

---

## 当前限制

- 默认向量索引在进程内存中，全量遍历 FAQ 与文档切片 embedding，适合 Demo 和小规模知识库，不适合大规模检索。
- embedding 以 JSON 形式存储在 SQLite 中，没有使用专门的向量数据库。
- 文档解析同步运行在 Express 进程内；加密、损坏和扫描 PDF 会返回稳定失败码，尚不支持 OCR、图片知识、网页采集、正式引用和页码跳转。
- 文档仍属于单一全局知识库；v0.2.6 不包含多租户分库、后台任务、文档版本或外部向量存储。
- `VectorStore` 已为未来接入 Qdrant 或 pgvector 留出接口，但默认部署仍保持低依赖。
- LLM 意图识别失败时会回退到关键词规则。
- 这是一个 pre-1.0 MVP 基座，不是完整生产客服平台。正式生产前应补充可观测性、更严格的鉴权、备份策略和外部向量存储。

---

## Roadmap

- 增加正式引用、页码跳转和无依据拒答。
- 扩展检索评测数据集和阈值调优能力。
- 增加网页、OCR 和图片知识来源适配器。
- 增加后台角色权限。
- 支持更大规模 FAQ 的导入、导出和批处理。
