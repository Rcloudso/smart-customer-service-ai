# 增量设计：LLM 非敏感配置用户自定义

> **项目**：smart-customer-service
> **增量类型**：功能增强 — LLM/Embed 非敏感配置支持环境优先与 `.env` 动态回写
> **设计原则**：最小修改范围，向后兼容，API Key 只允许环境变量或部署 Secret 注入

---

## Part A：系统设计

### v0.2.6 文档检索补充

聊天检索通过 `KnowledgeRetriever` 分别召回 FAQ 与文档向量候选，再合并字段感知的关键词候选，通过分数感知的倒数排名融合（RRF）统一排序并做来源多样性选择，避免 FAQ 数量较多时挤占全部全局 Top 5。自然语言文档查询会提取有限的中英文关键词用于 SQL `LIKE` 候选；GPU/显卡型号清单类问题执行确定性词汇扩展，查询 embedding 仍只生成一次。最多三条结果作为不可信知识材料进入 Prompt。

FAQ 与文档切片都持久化 `embedding_profile`，其值由 provider、模型、API Base 哈希和 embedding 输入结构版本组成。文档 embedding 输入包含文档标题、章节标题与正文。启动或运行时检测到 profile 变化后，先批量生成全部旧向量，再用 SQLite 事务原子更新；失败时保留旧向量和旧进程索引，并按 30 秒退避重试，避免半新半旧索引。

SSE 事件名称保持兼容：`faq` 仍只发送 FAQ；`done.content.knowledgeSources` 为可选字段，供新客户端展示文档名、切片序号和可选页码。助手正文使用禁用原始 HTML 的 Markdown 渲染，用户正文继续按纯文本展示。

意图分类使用严格的兼容链：优先发送带 `intent` 枚举、`confidence` 范围和 `reasoning` 字段的 `json_schema`；格式不受支持或响应校验失败时依次尝试 `json_object` 和普通文本 JSON。普通文本解析兼容 JSON 代码块和前后说明文字，但仍校验意图枚举及有限数值置信度。三条 LLM 路径均失败后才使用关键词分类，结构化格式协商每种只请求一次，避免确定性 4xx 被重复重试；无 Key 的本地模式直接使用关键词路径。意图日志只记录分类结果、格式和安全错误摘要，不记录用户消息内容。

### v0.2.6 会话生命周期与管理查询补充

“活跃会话”不是历史上所有 `status=active` 的累计值。系统在会话复用、管理列表和统计读取前，按 `SESSION_INACTIVITY_MINUTES` 将超时会话原子关闭，并记录 `close_reason=inactivity_timeout`；用户主动新建对话也会关闭当前会话。当前满意度入口是消息级评分，不会切断会话；超时关闭的同一浏览器会话可以在再次发言时恢复，避免前端历史上下文与服务端会话割裂。

关闭会话不删除消息。消息作为客服审计和知识审核证据继续保留，性能边界由会话创建时间、状态/更新时间和消息会话/时间复合索引、SQL 分页以及有限导出保证。对话 CSV 使用与列表相同的日期、意图和关键词筛选，导出每条消息的完整内容；超过 `CONVERSATION_EXPORT_MAX_MESSAGES` 时拒绝同步导出并要求缩小范围，避免全库一次性进入内存。

### 1. Implementation Approach

#### 核心挑战

1. **现有 config 是 `as const` 静态对象**，启动时从 env 一次性读取，无法运行时动态变更
2. **LLM client 是单例**，构造时固化 client 实例；改配置后需要重建
3. **chat 和 embed 共用同一 OpenAI client**，需要拆分为独立 client
4. **Secret 字段（apiKey）不得进入数据库或管理接口**，页面只展示环境注入状态

#### 技术选型

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 非敏感配置存储 | 本地 `.env` | 管理后台原子回写，当前进程立即同步 |
| 配置覆盖策略 | env 优先，历史 DB 行不再参与生效 | API Key 始终来自 env/部署 Secret |
| API Key 展示 | 只返回是否已配置 | 管理接口不接受、不返回密钥材料 |
| Client 重建策略 | `getLLMClient()` 内部检查 stale | 懒重建，避免每次请求都 new OpenAI |
| 前端状态管理 | 本地 useState | 配置页面简单，无需 Redux/Zustand |

#### 架构模式

```
┌─────────────────────────────────────────────────────┐
│              env vars / deployment secrets           │
│  LLM_API_KEY, EMBED_API_KEY (secret-only source)     │
└─────────────────┬───────────────────────────────────┘
                  │ 默认值
┌─────────────────▼───────────────────────────────────┐
│                 ConfigService                        │
│  getAll() → resolve current environment             │
│  getAll() → non-secret config + configured flags    │
│  save(nonSecretPartial) → 原子回写 .env + 热生效     │
└─────────────────┬───────────────────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
┌────────┐  ┌──────────┐  ┌──────────┐
│ config │  │ llm-client│  │ admin    │
│ .ts    │  │ .ts       │  │ config   │
│ (env)  │  │ (client)  │  │ route    │
└────────┘  └──────────┘  └──────────┘
```

---

### 2. File List

```
smart-customer-service/
├── .env.example                          # [修改] 新增 LLM_API_BASE, EMBED_* 变量
├── server/
│   ├── config.ts                         # [修改] env schema 扩展 + config.llm/embed 拆分
│   ├── index.ts                          # [修改] 新增 /api/admin/config 路由链
│   ├── db/
│   │   └── index.ts                      # [修改] model_configs DDL + 清除旧版 Key 行
│   ├── ai/
│   │   └── llm-client.ts                 # [修改] 独立 chat/embed client
│   ├── services/
│   │   └── config.service.ts             # [新建] 非敏感配置读写 + Key 配置状态
│   └── routes/
│       └── admin/
│           └── config.ts                 # [新建] GET/PUT /api/admin/config/model
└── client/
    └── src/
        ├── App.tsx                       # [修改] lazy import + Route
        ├── types/
        │   └── index.ts                  # [修改] 新增 ModelConfigDTO
        ├── api/
        │   └── admin.ts                  # [修改] 新增 getModelConfig / updateModelConfig
        └── pages/
            └── admin/
                ├── AdminLayout.tsx        # [修改] 新增第4菜单项"模型配置"
                └── ModelConfigPage.tsx    # [新建] LLM + Embed 配置表单
```

---

### 3. Data Structures and Interfaces

```mermaid
classDiagram
    %% ── Config Interfaces ──
    class LLMConfig {
        +string provider
        +string apiKey
        +string apiBase
        +string model
    }

    class EmbedConfig {
        +string provider
        +string apiKey
        +string apiBase
        +string model
    }

    class AppConfig {
        +LLMConfig llm
        +EmbedConfig embed
        +JwtConfig jwt
        +AdminConfig admin
        +DbConfig db
        +CorsConfig cors
        +RateLimitConfig rateLimit
    }

    %% ── DTO ──
    class ModelConfigDTO {
        +string llmApiBase
        +string llmModel
        +string embedProvider
        +string embedApiBase
        +string embedModel
    }

    class ModelConfigResponseDTO {
        +string llmApiBase
        +string llmModel
        +boolean llmApiKeyConfigured
        +string embedProvider
        +string embedApiBase
        +string embedModel
        +boolean embedApiKeyConfigured
    }

    %% ── Service ──
    class ConfigService {
        -string envFilePath
        +getAll() ModelConfigResponseDTO
        +save(updates ModelConfigDTO, resetKeys string[]) void
        +hydrate() void
        -syncRuntimeConfig() void
    }

    %% ── LLM Client ──
    class OpenAIClientImpl {
        -OpenAI chatClient
        -OpenAI embedClient
        -string chatModel
        -string embedModel
        -string configHash
        +chat(messages, options) Promise~string~
        +chatStream(messages, onToken, options) Promise~string~
        +embed(texts) Promise~EmbeddingResult[]~
        -ensureFresh() void
        -withRetry(fn, maxRetries) Promise~T~
    }

    class LLMClient {
        <<interface>>
        +chat(messages, options) Promise~string~
        +chatStream(messages, onToken, options) Promise~string~
        +embed(texts) Promise~EmbeddingResult[]~
    }

    %% ── Router ──
    class AdminConfigRouter {
        +GET /api/admin/config/model
        +PUT /api/admin/config/model
    }

    %% ── Relationships ──
    AppConfig *-- LLMConfig
    AppConfig *-- EmbedConfig
    ConfigService ..> ModelConfigDTO : reads/writes
    ConfigService ..> ModelConfigResponseDTO : returns
    ConfigService ..> AppConfig : syncs runtime
    OpenAIClientImpl ..|> LLMClient
    OpenAIClientImpl ..> AppConfig : ensureFresh()
    AdminConfigRouter ..> ConfigService : uses
```

---

### 4. Program Call Flow

#### 4.1 GET /api/admin/config/model — 获取非敏感配置与凭证状态

```mermaid
sequenceDiagram
    actor Admin
    Admin->>AdminConfigRouter: GET /api/admin/config/model
    AdminConfigRouter->>ConfigService: getAll()
    ConfigService->>ConfigService: resolveModelEnvironment(process.env)
    Note over ConfigService: 历史 DB 行不参与覆盖
    ConfigService->>ConfigService: Boolean(env LLM_API_KEY)
    Note over ConfigService: 不返回密钥材料
    ConfigService-->>AdminConfigRouter: ModelConfigResponseDTO
    AdminConfigRouter-->>Admin: { code: 0, data: { llmApiBase, llmModel, llmApiKeyConfigured, ... } }
```

#### 4.2 PUT /api/admin/config/model — 更新配置

```mermaid
sequenceDiagram
    actor Admin
    Admin->>AdminConfigRouter: PUT /api/admin/config/model { llmApiBase: "https://...", llmModel: "gpt-4" }
    AdminConfigRouter->>AdminConfigRouter: validate body (空值 key 剔除)
    AdminConfigRouter->>ConfigService: save(updates, resetKeys)
    ConfigService->>ConfigService: 临时文件写入 + 原子 rename
    ConfigService->>ConfigService: 更新 process.env 与运行时 config
    Note over ConfigService: 文件失败时不修改运行态
    ConfigService-->>AdminConfigRouter: void
    AdminConfigRouter-->>Admin: { code: 0, data: null, message: "ok" }
```

#### 4.3 Chat / Embed 调用 — 配置生效

```mermaid
sequenceDiagram
    actor User
    User->>ChatRoute: POST /api/chat { message }
    ChatRoute->>LLMClient: getLLMClient().chat(messages)
    LLMClient->>OpenAIClientImpl: ensureFresh()
    OpenAIClientImpl->>AppConfig: 读取当前 apiBase/model/apiKey
    AppConfig-->>OpenAIClientImpl: "https://custom.api.com/v1"
    OpenAIClientImpl->>OpenAIClientImpl: 比较 configHash，不一致则重建 chatClient
    Note over OpenAIClientImpl: new OpenAI({ apiKey, baseURL })
    OpenAIClientImpl->>OpenAI: chat.completions.create({ model, messages })
    OpenAI-->>OpenAIClientImpl: ChatCompletion
    OpenAIClientImpl-->>ChatRoute: "response text"
    ChatRoute-->>User: { reply }
```

---

### 5. Anything UNCLEAR

| 问题 | 假设 |
|------|------|
| **apiKey 如何配置** | 仅通过 `LLM_API_KEY`、`EMBED_API_KEY` 或部署 Secret 注入；PUT 携带 Key 字段返回 400 |
| **模型服务商** | LLM 与 Embedding 统一支持 `openai`、`openai-compatible`、`other`；OpenAI 固定使用官方地址，另外两类使用自定义 API Base URL |
| **config 热生效范围** | `ensureFresh()` 仅在每次 `chat()`/`embed()` 调用时检查，不依赖定时器或文件监听 |
| **LLM_API_KEY 不再单独存在** | 原 `OPENAI_API_KEY` 保留向后兼容：`LLM_API_KEY` 优先，fallback 到 `OPENAI_API_KEY` |
| **多实例并发** | 本地单进程使用原子文件替换；外部注入环境或只读文件系统通过部署配置变更与重部署管理 |
| **旧数据库配置的行为** | `initSchema` 幂等删除 Key 行；其他历史模型行保留但不再覆盖环境 |

---

## Part B：任务分解

### 6. Required Packages

```
无新增第三方依赖。所有功能复用现有依赖：
- openai (已安装，用于 OpenAI client)
- better-sqlite3 (已安装，保留历史 model_configs 表兼容)
- zod (已安装，用于请求体校验)
- tdesign-react (已安装，用于 ModelConfigPage UI)
```

### 7. Task List

---

#### T01：后端基础设施 — env 扩展 + DB 表 + AI 引擎适配

| 属性 | 值 |
|------|-----|
| **Task ID** | T01 |
| **Task Name** | 后端基础设施层 |
| **Source Files** | `server/config.ts`, `.env.example`, `server/db/index.ts`, `server/ai/llm-client.ts` |
| **Dependencies** | 无 |
| **Priority** | P0 |

**工作内容**：

1. **`.env.example`**：使用 `LLM_PROVIDER`、`LLM_API_BASE`、`EMBED_PROVIDER`、`EMBED_API_BASE`、`EMBED_MODEL`、`EMBED_API_KEY` 字段
2. **`server/config.ts`**：
   - env schema 新增 5 个字段（含默认值）
   - `config.llm` 结构由 `{ provider, openaiApiKey, model, embedModel }` 拆为 `{ provider, apiKey, apiBase, model }`
   - 新增 `config.embed: { provider, apiKey, apiBase, model }`
   - `apiKey` 兼容逻辑：`LLM_API_KEY ?? OPENAI_API_KEY`；`EMBED_API_KEY` 空字符串 fallback 到 llm.apiKey
   - 移除 `as const`（ConfigService 需要动态读取）
3. **`server/db/index.ts`**：`initSchema()` 中新增 `model_configs` 表 DDL
4. **`server/ai/llm-client.ts`**：
   - 拆为两个独立 OpenAI client：`chatClient` + `embedClient`
   - `chatClient` 使用 `config.llm.*`创建
   - `embedClient` 使用 `config.embed.*`创建，`baseURL` 非空时传入
   - `embed.apiKey` 为空时 fallback `config.llm.apiKey`
   - 新增 `ensureFresh()` 方法：比较当前 config hash，变化时重建对应 client
   - `getLLMClient()` 单例模式保持不变

---

#### T02：后端业务层 — ConfigService + API 路由 + 路由注册

| 属性 | 值 |
|------|-----|
| **Task ID** | T02 |
| **Task Name** | 后端业务与 API 层 |
| **Source Files** | `server/services/config.service.ts`, `server/routes/admin/config.ts`, `server/index.ts` |
| **Dependencies** | T01 |
| **Priority** | P0 |

**工作内容**：

1. **`server/services/config.service.ts`**（新建）：
   - `ConfigService` 类，单例导出
   - `getAll()`：返回非敏感配置，并以布尔值表示环境凭证是否存在
   - `save(updates, resetKeys)`：只接受非敏感字段，原子回写 `.env`
   - 文件成功替换后才更新 `process.env` 与运行时 `config`
   - `getAll()`：从环境解析有效配置；历史 DB 行不参与覆盖
2. **`server/routes/admin/config.ts`**（新建）：
   - `GET /model` → 调用 `configService.getAll()`，返回 `{ code: 0, data: ModelConfigResponseDTO }`
   - `PUT /model` → strict zod 校验非敏感字段，拒绝任何 API Key 字段
   - 挂载 `authMiddleware` + `adminOnlyMiddleware`
3. **`server/index.ts`**：
   - 新增变量 `let adminConfigRoutes: express.Router`
   - 新增懒加载路由链 `app.use('/api/admin/config', ...)`
   - 模式与现有 6 条路由链完全一致

---

#### T03：前端数据层 — 类型定义 + API 客户端 + ModelConfigPage

| 属性 | 值 |
|------|-----|
| **Task ID** | T03 |
| **Task Name** | 前端数据层与 UI 页面 |
| **Source Files** | `client/src/types/index.ts`, `client/src/api/admin.ts`, `client/src/pages/admin/ModelConfigPage.tsx` |
| **Dependencies** | T02 |
| **Priority** | P0 |

**工作内容**：

1. **`client/src/types/index.ts`**：新增 `ModelConfigDTO` 和 `ModelConfigResponseDTO` 类型定义
2. **`client/src/api/admin.ts`**：新增 `getModelConfig()` 和 `updateModelConfig(updates)` 两个 API 函数
3. **`client/src/pages/admin/ModelConfigPage.tsx`**（新建）：
   - 分两个卡片区块：**LLM 配置** 和 **EmbedModel 配置**
   - LLM 区字段：Provider（`openai`/`openai-compatible`/`other`）、非 OpenAI 时显示 API Base、Model、API Key 环境配置状态（只读）
   - Embed 区字段：Provider（`openai`/`openai-compatible`/`other`）、非 OpenAI 时显示 API Base、Model、API Key 环境配置状态（只读）
   - 页面加载时调用 `getModelConfig()` 获取非敏感当前值与凭证状态
   - 保存按钮 → 过滤空值字段 → `updateModelConfig()` → 成功后重新加载
   - API Key 不提供输入框；页面明确提示通过环境变量或部署 Secret 注入
   - 使用 TDesign 的 `Form`、`Input`、`Select`、`Card`、`Button`、`Message` 组件
   - 与现有管理页面风格一致（白底卡片 + 24px padding）

---

#### T04：前端集成 — 菜单 + 路由

| 属性 | 值 |
|------|-----|
| **Task ID** | T04 |
| **Task Name** | 前端集成（菜单 + 路由） |
| **Source Files** | `client/src/pages/admin/AdminLayout.tsx`, `client/src/App.tsx` |
| **Dependencies** | T03 |
| **Priority** | P1 |

**工作内容**：

1. **`client/src/pages/admin/AdminLayout.tsx`**：
   - `MENU_ITEMS` 数组新增第 4 项：`{ path: '/admin/config', label: '模型配置', icon: <SettingIcon /> }`
   - `activePath` 逻辑新增 `/admin/config` 匹配
   - 从 `tdesign-icons-react` 引入 `SettingIcon`
2. **`client/src/App.tsx`**：
   - 新增 `const ModelConfigPage = lazy(() => import('./pages/admin/ModelConfigPage'))`
   - 在 `/admin` 的 `<Route>` 内新增 `<Route path="config" element={<ModelConfigPage />} />`

---

### 8. Shared Knowledge

```
- 所有 API 响应统一使用 { code: 0, data: T, message: 'ok' } 格式，code !== 0 表示错误
- 管理后台路由全部挂载 authMiddleware + adminOnlyMiddleware
- model_configs 仅允许非敏感 key：llmApiBase, llmModel, embedProvider, embedApiBase, embedModel
- env var 优先级：LLM_API_KEY > OPENAI_API_KEY（兼容旧版），其他字段直接对应
- API Key 接口规则：不接受、不返回；仅返回 `llmApiKeyConfigured` / `embedApiKeyConfigured`
- config 热生效：每次 LLM 调用时通过 ensureFresh() 比较 hash，变化时重建 client（无锁，单进程安全）
- 不动的文件（绝对不能改）：所有 server/ai/ 下的其他文件、所有 middleware、所有现有 route、所有现有 service
```

---

### 9. Task Dependency Graph

```mermaid
graph TD
    T01["T01: 后端基础设施<br/>config.ts + .env.example<br/>+ db/index.ts + llm-client.ts"]
    T02["T02: 后端业务层<br/>config.service.ts<br/>+ routes/admin/config.ts<br/>+ server/index.ts"]
    T03["T03: 前端数据层+UI<br/>types/index.ts + api/admin.ts<br/>+ ModelConfigPage.tsx"]
    T04["T04: 前端集成<br/>AdminLayout.tsx<br/>+ App.tsx"]

    T01 --> T02
    T02 --> T03
    T03 --> T04
```
