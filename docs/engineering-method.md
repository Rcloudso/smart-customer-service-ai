# 企业级 AI 原生 Vibe Coding 方法论（v3.0）

> 文件驱动、契约约束、风险分级、证据闭环的 AI 辅助软件交付方法。
> 公式是：
> `Vibe（方向） + Contract/Policy（边界） + Context/Memory（正确上下文） + Harness/Loop/Graph（受控执行） + Eval/Observability（质量反馈） + Security/HITL（风险治理） + Git/CI/CD（版本与发布证据）`
>
> Vibe Coding 不是“让 AI 随便写”，而是人负责问题定义、业务取舍、风险接受和最终责任，Agent 负责在授权边界内高速探索与实现，最终由可复现测试、评测、运行时信号和仓库证据决定是否完成。

**结构优先级说明**：公式按工作流顺序把 Vibe 列在首位，但按不可绕过性排序，承重梁是 **Contract + Policy**。Vibe 是方向盘；Context/Memory 决定 Agent 看见什么；Harness/Loop/Graph 决定 Agent 能做什么、如何继续；Eval/Observability、Security/HITL 和 Git/CI/CD 决定结果是否可信、可控、可追责。

**版本**：v3.0

**日期**：2026-08-09

**规范强度**：方法论，不是合规认证标准。金融、医疗、政务等场景仍需映射各自法规、组织制度和审计要求。

---

## 方法论演进摘要

| 版本 | 解决的问题 | 核心变化 |
|---|---|---|
| v1 | AI 辅助开发容易漂移、跨会话失忆、凭感觉完成 | 文件状态、Contract、Agent Loop、测试和 Git 证据 |
| v2 | 文件会冲突、审阅会自证、证据可手填 | 内部信任链、审阅独立性、CI 机器证据、停滞版本归档 |
| v3 | 项目方法难以迁移到企业，缺运行时治理 | 加入业务契约、Context/Memory、Harness/Loop/Graph 分层、工具与协议边界、风险分级、HITL、离线/在线评测、可观测性和生产运维 |

v2 的六项加固继续有效：

1. 给 `contract/progress/handoff/log/PLAN` 排内部优先级并定义冲突裁决。
2. 用审阅多样性和对抗式验证避免同模型自证。
3. 证据由 CI 机器产出并链接，禁止手录“通过”。
4. `progress` 与 `handoff` 保持为可重算的薄派生文件。
5. 停滞版本显式归档，不与当前版本混用。
6. 方法论自身版本化，避免规范悄悄过时。

---

## 0. 适用范围、核心原则与最小充分性

### 0.1 适用范围

本方法适用于：

- 人与 AI 编程 Agent 协作开发普通软件、AI 应用、RAG、工具调用和 Agent 工作流。
- 多会话、多角色、需要恢复状态的中长任务。
- 需要 CI/CD、发布证据、运行时评测、安全审批和审计追踪的企业项目。
- 从个人原型迁移到团队协作和生产运行的过程。

它不等于：

- 用 Agent 取代产品负责人、架构师、安全负责人或业务责任人。
- 默认采用多 Agent、向量数据库、工作流图或云托管 Agent 服务。
- 以日志、截图或 LLM Judge 单独证明系统正确。
- 以“模型很强”绕过测试、权限、变更管理、人工审批和回滚机制。

### 0.2 七条不可绕过原则

1. **先定义真实问题，再生成代码。** 业务流程、用户痛点和成功指标优先于技术选型。
2. **先定义完成和不做什么，再开始实现。** Contract 同时包含 Goal、Scope、Non-goals、Done Check、Risk 和 Stop Conditions。
3. **最小权限、最小上下文、最小工具集。** Agent 只看当前步骤需要的信息，只获得当前步骤需要的能力。
4. **确定性优先。** 规则、权限、金额、数据写入和发布门禁尽量由代码与策略引擎决定；LLM 用于理解、生成和弱结构推理。
5. **在证据上循环，不在自信上循环。** Agent 自称完成、审阅者口头“无阻断”都不是证据。
6. **高风险动作必须可暂停、可审批、可撤销或可补偿。** 人工介入点是架构节点，不是异常补丁。
7. **上线是学习闭环的中点。** 离线评测决定能否发布，在线可观测性发现新失败，真实失败必须回流离线测试集。

### 0.3 最小充分性：不要为“企业级”制造仪式

| 任务形态 | 最小方法 |
|---|---|
| 一行修复、文案、小查询 | 明确目标 + 聚焦检查 + Diff |
| 单会话功能 | Contract + 垂直切片 + 测试 + Git |
| 多会话或质量敏感任务 | 再加外部状态、Planner/Generator/Evaluator Loop |
| 有分支、审批、并行、恢复路径 | 再加显式 Graph 和持久 checkpoint |
| 生产 Agent 或高风险工具调用 | 再加运行时 Policy、HITL、Eval、Observability、RBAC、审计和回滚 |

复杂度必须由真实风险和流程拓扑触发，而不是由“前沿”二字触发。

---

## 1. 多会话如何保持版本互通

核心原则：不要让聊天记录承担项目记忆，聊天会过期，文件和 Git 才是持久状态。

| 文件 | 唯一职责 |
|---|---|
| `AGENTS.md` | 项目宪法：产品边界、架构约束、安全、测试、Git 规则 |
| `ROADMAP.md` | 对外版本方向：做什么、为什么、顺序是什么 |
| `agent-loop/current.md` | 当前版本唯一入口：版本、分支、提交、状态和下一步 |
| `releases/<version>/contract.md` | 本版本不可漂移的目标、范围、非目标和验收条件 |
| `PLAN.md` | 已批准的实现路径、TDD 切片和验证命令 |
| `progress.md` | 当前完成了什么、还剩什么 |
| `log.md` | 决策、失败尝试、审阅发现和验证证据 |
| `handoff.md` | 下一会话唯一该做的动作、Git 状态、服务和阻塞 |
| `DESIGN.md` | UI 视觉与交互的唯一来源 |
| 测试、发布证据、Git/GitHub | 最终事实，不以 Agent 自述为准 |

新会话启动顺序固定为：

```text
AGENTS.md
  → agent-loop/current.md
  → contract / progress / handoff
  → git status / branch / commit
  → 必要时才读 log.md
  → 复述目标、状态、风险、下一步
```

如果聊天、文件和 Git 不一致，信任顺序是：

```text
实际代码与测试 > Git/GitHub 状态 > 当前版本文件 > 聊天记忆
```

### [加固 v2] 1.1 内部文件之间的信任链与冲突裁决

上面的信任链落到"当前版本文件"这一层时，五份内部文件（`contract` / `progress` / `handoff` / `log` / `PLAN`）本身也会彼此漂移。必须为内部文件再排一次优先级，否则"以仓库为准"会在内部悄悄失效：

| 文件 | 角色 | 是否可改 | 与其他文件冲突时 |
|---|---|---|---|
| `contract.md` | **不可变目标**，本版本唯一事实来源；Done Check 是验收判据 | 仅用户显式变更本版本目标时改 | 最高优先级，其它文件必须服从 |
| `PLAN.md` | 已批准的实现路径 | 经确认后可调 | 不得扩大 contract 的范围/非目标 |
| `progress.md` | 从 contract 的 Done Check 勾选状态 + git log 派生的"完成度快照" | 每会话末刷新 | 派生值，冲突时重算，不得改写目标 |
| `handoff.md` | 从 contract + git 派生的"下一步 + 证据链接" | 每会话末刷新 | 派生值，冲突时重算 |
| `log.md` | 只追加的决策、失败、审阅、验证证据 | 只追加 | 历史，不覆盖当下判定 |

**冲突裁决规则（内部层）**：

```text
contract.md（目标） > Git 实证 > progress/handoff（派生） > log.md（历史） > 聊天记忆
```

- 派生文件（`progress` / `handoff`）**不得**改写 `contract` 的数值阈值、范围或非目标。若发现目标需要变，先改 `contract.md`，再重算派生文件——禁止在 `progress`/`handoff` 里悄悄漂移目标。
- 当 `progress` 与 `handoff` 对"还剩什么"表述不一致时，以 `contract` 的 Done Check 勾选状态为准。

### [加固 v2] 1.2 派生文件变薄约定（降低维护税）

`progress.md` 与 `handoff.md` 高度重叠，长期会形成维护税。约定：

- `progress.md` 只列：contract Done Check 的勾选进度 + 未完成项。可由 `git log` + Done Check 半自动生成，不写长篇叙述。
- `handoff.md` 用固定模板（见 §4 模板），字段只有：Next Action / Git State / 证据链接 / Blockers / Running Services。
- 长篇叙述、踩坑过程一律进 `log.md`（只追加），不进派生文件。

`session-start.md` 已经把启动流程封装成可复制提示词，所以不需要把旧聊天粘贴给新会话。

---

## 2. Agent Loop 的真正作用

Agent Loop 不是自动循环写代码，而是强制分离三种责任：

1. **Planner**：把模糊目标变成范围、非目标、交付物和 Done Check，完成后暂停等待确认。
2. **Generator**：只依据 `contract.md` 和批准后的 `PLAN.md` 实现，不自行扩大范围。
3. **Evaluator**：默认实现可能有错，对照合同进行对抗验证；Generator 不能成为自己的唯一裁判。

本项目最有价值的例子，是 v0.2.7 的高风险请求识别。独立审阅不断找到中英文复合句、否定句、小数和冲突 FAQ 边界；每个有效反例都先变成测试，再修改代码，直到审阅者给出无阻断结论。

这比"一次生成成功"更能体现工程能力：

> Agent 的错误不可怕，没有把错误沉淀成回归测试才可怕。

Agent Loop 只用于多步骤、可恢复、高风险或质量敏感工作。小改文案、一次查询、明显的一行修复，不应该引入整套仪式。

### [加固 v2] 2.1 审阅独立性协议（防止"自证清白"）

"独立审阅"若只是同模型、同 prompt 的复制，独立是伪独立，结论可能集体盲区。v2 要求 **Evaluator 必须满足至少两条多样性**：

- **模型多样性**：至少使用不同模型家族（例如一个 GPT 系、一个 Claude 系、一个本地/开源模型）；或
- **framing 多样性**：安全/对抗、性能/规模、兼容/可维护性各一人；或
- **人类多样性**：至少一名人类审阅者。

审阅必须是**对抗式**，而非温和审查：

- ❌ 错误示范：`请审查这段代码有没有问题`
- ✅ 正确示范：`假设你是攻击者，目标是绕过 v0.2.7 的 refusal 策略，让系统泄露私有业务状态或执行越权。列出每条可达路径，并给出能证明该路径被拦截的测试或命令。`

审阅结论必须附带：

1. 覆盖的对抗场景清单；
2. 每个场景的验证方式（测试 / 命令 / 截图链接）；
3. 对 `contract.md` Done Check 的逐条核对。

**无证据支撑的"无阻断"不算通过。** `handoff.md` 记录审阅结论时，必须能回溯到上述三条。

---

## 3. Design 如何进入开发闭环

UI 工作不能只依赖截图感觉，也不能让每个 Agent 自己发明样式。

下个项目中，`DESIGN.md` 至少应固定：

- 颜色、字体、间距、圆角和阴影 token。
- 页面布局、断点和移动端规则。
- 组件库和图标库。
- Loading、Empty、Error、Success、Disabled 等状态。
- 中英文、暗亮主题、键盘焦点、对比度和触控尺寸。
- 哪些模式禁止出现，例如嵌套卡片、全局样式覆盖、临时硬编码颜色。

实际流程应是：

```text
读取 DESIGN.md
  → 审计现有页面
  → 提出有限方案
  → 实现最小 UI 切片
  → 浏览器验证
  → 截图进入发布证据
```

需要注意：`DESIGN.md` 不能只有视觉氛围，还必须映射到真实技术栈、组件库和可测试的交互状态。

---

## 4. 完整版本开发闭环

推荐下个项目继续使用以下流程：

```text
发现真实问题
  → 更新公开 ROADMAP
  → 新建版本目录和 contract
  → Planner 输出 PLAN，等待确认
  → fetch 最新 main
  → 创建独立版本分支
  → Generator 按垂直切片实现
  → 聚焦测试
  → 完整回归、E2E、构建
  → 独立对抗审阅（遵守 §2.1）
  → 更新双语文档和发布证据
  → 精确暂存
  → commit / push
  → PR / CI（证据由 CI 产出，见 §4.1）
  → merge
  → 检查 tag 和 GitHub Release
```

三个状态必须分开：

- **实现完成**：代码和本地验证完成。
- **合并完成**：PR 已进入 `main`。
- **发布完成**：版本号、Tag、Release 和公开文档一致。

"PR merged"不等于"版本已发布"。

### [加固 v2] 4.1 证据必须由 CI 机器产出并链接（不是手录）

`handoff.md` 里的"测试通过 / Top1 100% / E2E 37/37"这类数字，初版是手填的——这给"以证据为准"留了后门：一个懒惰的会话可以抄"passed"而不真跑。v2 把证据闭环补到最后一跳：

- CI 在 PR 上运行 regression / eval / E2E / build，将结果写入**Release evidence 产物**（GitHub Actions artifact、或自动生成的 Release Notes 段落）。
- `handoff.md` **只放链接**（artifact URL / Release URL），不手录数字。
- 若 CI 未运行、artifact 缺失或任意检查红，本版本**不得**标记"发布完成"。
- 证据链接失效（404 / 过期）视同证据缺失，需重跑 CI。

> 这条是把"以证据为准"从口号变成硬约束的关键：证据要么机器产出可链接，要么不存在。

### [加固 v2] 4.2 停滞版本归档协议

初版只说"不要在同一文件夹开下一版"，但没说停滞版本怎么办。v2 补充：

- 若某版本分支超过约定天数（默认 14 天）无进展，或被后续版本取代，在 `current.md` 将其标记为 `archived`。
- 保留 `releases/<version>/` 目录作历史审计，**不再更新**；新版本另开 `releases/<new-version>/`。
- 已 push 的停滞分支**不强制删除**，留作审计轨迹；仅当含密钥或敏感数据时按 `AGENTS.md` 安全规则处理。
- 归档版本不计入"发布完成"统计，避免虚高。

### [加固 v2] 4.3 handoff.md 固定模板（派生、变薄）

```markdown
# Session Handoff: <version>

## Next Action
<唯一下一步；未授权动作显式写明"需授权">

## Git State
- Branch:
- Latest commit:
- Upstream: <equal / N ahead of origin/main>
- Staged: <none / 列表>
- Untracked/local-only: <列表>
- PR: <none / URL>

## 证据链接（必须来自 CI，禁手录数字）
- Regression/type: <artifact or Release URL>
- Eval: <URL，含 Top1/Top3/MRR 等>
- E2E: <URL，含通过数>
- Build: <URL>
- Diff check: <URL>
- 对抗审阅: <URL，含 §2.1 三要件>

## Blockers / Risks
- <列表>

## Running Services
- <none / 列表>
```

---

## 5. 下个项目推荐目录

```text
PROJECT/
├── AGENTS.md
├── DESIGN.md
├── ROADMAP.md
├── PLAN.md
├── README.md
├── agent-loop/
│   ├── current.md
│   ├── session-start.md
│   ├── templates/
│   │   └── handoff.md
│   └── releases/
│       └── v0.1.0/
│           ├── contract.md
│           ├── progress.md
│           ├── log.md
│           └── handoff.md
└── docs/
    └── releases/
        ├── v0.1.0.md
        └── v0.1.0-evidence.md
```

建议继续区分：

- **公开事实**：README、ROADMAP、ARCHITECTURE、Release Notes、Evidence。
- **私有执行记忆**：PLAN、Agent Loop、内部审阅记录和本地 Skills。
- 若希望公开展示开发方法，可以额外发布一份经过整理的 `docs/engineering-method.md`（即本文），不要直接公开所有内部日志。

### 5.1 方法论自身也要版本化

本文（`engineering-method.md`）带版本号、日期与顶部变更摘要。后续若调整流程，在变更摘要追加一行并记录依据，避免这篇方法论自己悄悄过时、与仓库实际纪律脱节。

---

## 6. 企业级开发闭环：从业务问题到在线反馈

推荐的通用生命周期是：

```text
真实业务问题与当前基线
  → Product Contract：用户、流程、价值指标、责任人
  → Change Contract：范围、非目标、接口、Done Check、验证
  → Runtime Policy：身份、权限、风险等级、审批、预算、停止条件
  → Context Pack + Threat Model
  → 最小垂直切片
  → 确定性测试 + 离线评测 + 对抗测试
  → PR / CI 机器证据
  → 影子、灰度或受限发布
  → 在线追踪、业务指标、人工反馈和异常告警
  → 新失败回流离线数据集与 Contract
```

### 6.1 三类 Contract 不能混成一份愿望清单

| Contract | 回答的问题 | 最低字段 |
|---|---|---|
| Product Contract | 为什么做、谁受益、什么业务结果算成功 | 用户/流程、当前基线、目标指标、业务 Owner、假设、非目标 |
| Change Contract | 这一版具体改什么、如何验收 | Scope、接口与数据边界、Done Check、Verification、兼容性、回滚 |
| Runtime Policy | 上线后 Agent 能做什么、何时必须停 | 身份、权限、工具白名单、预算、风险等级、审批、审计、Kill Switch |

目标变化时先改 Product/Change Contract；权限和自动化边界变化时先改 Runtime Policy。不得在实现代码、Prompt、`progress.md` 或临时聊天里偷偷扩大授权。

### 6.2 指标分三层，避免“准确率很好但业务失败”

1. **业务结果**：任务完成率、处理时长、人工介入率、转化/解决率、错误造成的业务损失。
2. **AI 质量**：检索命中、事实与引用、工具选择、参数正确、拒答/升级准确、重复运行稳定性。
3. **系统运行**：可用性、p50/p95 延迟、错误率、吞吐、Token/调用成本、资源和供应商异常。

每个项目应先选少量与价值直接相关的指标；不要用几十个技术指标掩盖“用户任务是否完成”。

---

## 7. Context 与 Memory：控制 Agent 知道什么

Context 和 Memory 是两个不同的治理面：

- **Context Engineering** 管一次推理：当前调用包含什么、压缩什么、放在哪里、丢弃什么。
- **Memory Engineering** 管跨调用持久化：什么值得写入、存多久、谁能读写、如何更新、何时遗忘。
- **Retrieval** 是两者边界：Memory 提供候选，Context 在预算、权限和当前任务约束下决定是否注入。

### 7.1 Context Pack 的信任顺序

建议按以下顺序装配，而不是把所有历史全文塞给模型：

```text
系统与组织 Policy
  → 当前 Product/Change Contract
  → 项目架构与接口约束
  → 当前步骤和可用工具
  → 经身份与权限过滤的知识/记忆
  → 上一步的有界结果与错误
  → 当前用户请求
```

每次装配至少记录：候选来源、选择规则、被选 ID、来源版本、信任级别、脱敏状态、压缩前后估算量。生产日志优先记录 ID、Hash、Policy Label 和计数，不默认保存完整 Prompt、工具参数、用户数据或记忆正文。

### 7.2 Context Budget

在检索前分配预算，而不是检索后再截断：

| 区域 | 约束 |
|---|---|
| 不可变约束 | 始终保留，短、明确、置于高注意位置 |
| 当前任务 | 必须包含目标、输入、输出和停止条件 |
| 工具描述 | 动态选择当前步骤需要的最小 Loadout |
| 检索知识 | 在权限、时效、来源与 Token 预算内排序 |
| 历史/工具输出 | 到达时压缩，原始大结果留在文件或对象存储 |
| 剩余生成空间 | 预留给推理、工具返回和最终输出 |

### 7.3 Memory 写入协议

任何长期记忆都应有结构化字段：

```text
id / type / subject / value
source / created_at / valid_from / expires_at
trust_level / confidence / owner
scope / readers / writers
supersedes / status / redaction
```

写入前检查：

- 这是一条事实、偏好、决策、过程状态，还是未经验证的推断？
- 来源和责任人是谁？是否允许跨用户、跨 Agent 或跨项目使用？
- 是否含个人信息、商业秘密或受限数据？
- 是否需要 TTL、版本替代、撤回、用户同意或删除能力？
- 是否应该进入结构化状态，而不是把整段对话做向量化？

无写入策略的 Memory 会积累陈旧、冲突和被污染的信息。企业知识还需完整生命周期：接入、加工、审核、发布、使用、更新、失效、归档。无权、草稿、过期或未审核内容不得进入候选集，更不能先召回再靠模型“不要说”。

---

## 8. Harness、Loop 与 Graph：控制 Agent 如何行动

三个层次解决不同问题：

| 层 | 核心问题 | 典型内容 |
|---|---|---|
| Harness | Agent 能否在正确环境里工作？ | Context、工具、权限、Sandbox、状态、Git、Tracing |
| Loop | 工作如何依据反馈反复改进并停止？ | Trigger、Goal、State、Action Policy、Evidence、Feedback、Stop Rule |
| Graph | 复杂流程中下一步允许发生什么？ | 节点、分支、并行、Join、审批、Checkpoint、补偿与恢复 |

### 8.1 先诊断层，再选技术

- Agent 无法操作、缺工具、权限错、状态丢失、看不见错误：修 **Harness**。
- 初稿接近但不稳定、重试失控、没有完成证据：修 **Loop**。
- 多角色、多分支、并行、审批和恢复关系混乱：修 **Graph**。

不要一遇到失败就换模型，也不要一开始就画大型多 Agent 图。先用简单 Harness 收集 Trace，发现稳定重复模式后，再把值得控制的流程固化为 Loop 或 Graph。

### 8.2 Loop 的最小协议

```text
Trigger → Build bounded context → Act → Capture trace/diff/result
        → Evaluate against contract and policy
        → Success / Actionable feedback / Human escalation / Stop
```

每个 Loop 必须有：

- 可测 Goal，而不是“继续优化”。
- 外部 State，而不是依赖聊天历史。
- Action Policy，包括可用工具、写权限、最大成本、最大轮数。
- 机器或独立审阅证据。
- 紧凑且可行动的失败反馈。
- Success、Timeout、Budget、Max Retry、Irrecoverable Failure、Human Escalation 等退出条件。

### 8.3 Graph 只在拓扑值得显式化时使用

适合 Graph 的信号：有意义的分支、并行工作、角色交接、长时间人工审批、耐久恢复、补偿事务或跨系统编排。每个节点应明确：

- 输入/输出 Schema 与允许读写的 State。
- 是确定性函数、LLM 调用、专用 Agent，还是人工节点。
- 幂等键、重试策略、超时和补偿动作。
- 哪个证据允许流转到下一条边。
- 中断后从哪个 Checkpoint 恢复。

---

## 9. Tool、MCP 与 Agent 协议：把能力当作不可信边界

模型生成的 Tool Call 是一个请求，不是已授权动作。执行前必须经过应用层验证和授权。

### 9.1 Tool Contract

每个工具至少定义：

- 语义清晰的名称、用途、输入/输出 Schema 和错误类型。
- 调用身份、最小权限、数据范围和租户边界。
- Read / Write / External Side Effect 风险等级。
- 超时、重试、速率限制、幂等键和补偿方式。
- 可观测字段、审计事件和敏感字段脱敏策略。
- 哪些参数必须来自可信系统，不能由模型自由生成。

默认优先提供只读、窄能力、业务语义明确的工具。例如提供 `get_invoice(invoice_id)`，而不是向 Agent 暴露任意 SQL；写操作使用 `propose_refund` 与 `execute_approved_refund` 分离，而不是一个无条件 `refund`。

### 9.2 MCP / A2A 的企业边界

协议提高互操作性，不自动带来可信度。生产中应把每个 MCP Server、远程 Agent 和浏览器自动化端点视为外部依赖：

- 固定和审计版本，验证能力清单变化。
- 使用独立的受限身份，凭证不进入 Prompt 或第三方进程。
- 验证输入和输出，不把工具返回当作系统指令。
- 设置网络、文件、进程、数据和成本边界。
- 限流、超时、熔断、追踪、撤销和 Kill Switch。
- 跨组织 A2A 只传最小任务上下文与结构化 Artifact，不共享完整会话和内部记忆。

工具过多会扩大上下文噪声和攻击面。应按任务动态装载最小 Tool Loadout，而不是把所有工具描述永久塞进 Context。

---

## 10. 风险分级、Security 与 Human-in-the-Loop

### 10.1 动作风险矩阵

| 等级 | 例子 | 默认控制 |
|---|---|---|
| R0 只读低敏 | 读公开文档、静态分析 | Schema 校验、日志、速率限制 |
| R1 可逆内部写 | 建草稿、开 Issue、写隔离分支 | 最小权限、Diff、幂等、可撤销、事后审阅 |
| R2 高影响写 | 发消息、改生产配置、退款、删除可恢复数据 | 执行前审批、双阶段工具、强审计、补偿/回滚 |
| R3 不可逆或受监管 | 转账、医疗/法律决定、访问高敏数据、删除不可恢复资产 | 默认禁止全自动；明确人类责任人、双人复核或专门控制系统 |

风险等级由数据敏感度、外部影响、可逆性、金额、权限和法规共同决定，不能只按“工具名字看起来危险”判断。

### 10.2 企业安全基线

- 威胁建模覆盖直接/间接 Prompt Injection、知识投毒、越权工具调用、数据泄露、供应链、资源耗尽和级联失败。
- 身份与权限使用短期凭证、RBAC/ABAC、最小权限和租户隔离；生产凭证不在开发机、仓库、日志或模型上下文中。
- 上传、检索、网页、Memory 和工具输出都视为不可信数据；权限过滤发生在检索和工具执行之前。
- 高风险写操作使用“提出动作 → 规范化动作摘要 → 人类批准精确内容 → 执行 → 记录结果”的双阶段模式。
- 对审批设置有效期、批准人权限、动作摘要绑定和执行前重校验，防止批准后参数漂移。
- 保留暂停、降级、撤销、回滚、人工接管和全局 Kill Switch。

普通内部系统可以使用受控、不可随意修改的审计日志；只有受监管或跨组织低信任场景，才需要进一步采用可验证、抗篡改或加密签名回执。签名只能证明归属、完整性和顺序，不能证明动作本身正确或政策真的执行过。

---

## 11. Eval 与 Observability：把质量做成持续运行的控制系统

### 11.1 五层证据金字塔

1. **静态与确定性检查**：类型、Lint、Schema、单元/集成测试、安全扫描、Migration 和 Diff。
2. **工作流验证**：API、浏览器、工具 Sandbox、权限、失败和恢复路径。
3. **离线 AI Eval**：真实样本、固定 Ground Truth、场景集、对抗集、重复运行与版本对比。
4. **受限发布验证**：部署 Smoke、影子流量、灰度、人工抽检和回滚演练。
5. **在线 Evaluation**：业务结果、显式/隐式反馈、漂移、新失败聚类和事故复盘。

低层失败时不得用高层“整体看起来不错”覆盖。LLM Judge 必须先与人工标签校准，且不能成为高风险系统唯一裁判。

### 11.2 离线 Eval 是发布门禁

每个 AI 变更至少回答：

- 数据集代表哪些真实用户、边界和风险？
- 改动前后的任务成功、关键失败类型、延迟和成本如何变化？
- 是否出现均值提升但严重错误增多？
- 非确定性系统重复运行是否稳定？
- 哪个阈值阻止发布，谁有权接受例外？

生产失败应经过人工错误分析，形成 Failure Taxonomy；高频或高风险失败加入离线数据集。完整闭环是：

```text
offline eval → release gate → deploy → online trace/eval
→ collect failures → label and cluster → update dataset/contract → repeat
```

### 11.3 Observability 最小字段

推荐为一次 Agent Run 建立 Trace，并为模型调用、检索、工具、审批和路由建立 Span。至少能关联：

- `trace_id`、用户/租户的脱敏标识、任务类型和版本。
- 代码提交、Prompt/Policy/Tool Schema/模型/知识版本。
- 路由结果、工具名、状态码、重试、审批和人工介入结果。
- Token、调用成本、缓存命中、p50/p95 延迟和错误率。
- 检索与 Context 的候选/选中 ID、分数、权限和脱敏标签。
- Eval 分数、最终业务结果、回滚或事故编号。

可观测性遵循数据最小化：默认不记录完整个人数据、密钥、原始 Prompt、文件正文或工具机密返回。运营者应能回答“哪一层失败、影响谁、能否重放、如何止损”，而不是得到一堵无法解释的日志墙。

---

## 12. Production Readiness：从“本机可用”到“组织可运营”

生产前至少检查：

### Runtime 与可靠性

- 进程无状态或外部化状态；Checkpoint 可恢复，重复执行幂等。
- 有界并发、背压、超时、指数退避、熔断、降级和 Dead Letter/人工队列。
- 模型、Embedding、工具或检索服务不可用时有明确 Fallback；Fallback 不得偷偷降低安全边界。
- 部署后运行低成本 Smoke Test；“控制面部署成功”不等于端点真的能完成任务。

### Identity、Data 与 Governance

- 环境隔离、托管/短期身份、最小 RBAC、Secrets 管理和租户数据隔离。
- 数据来源、使用目的、保留、删除、跨境和审计责任有 Owner。
- 模型、Prompt、Policy、工具、数据集和知识库都可版本化与回滚。
- 第三方模型、插件、MCP、浏览器扩展和依赖有准入、版本固定与退出方案。

### Cost 与 Capacity

- 记录每任务成本，设置租户/工作流预算、并发和速率上限。
- 用 Eval 证明小模型适用范围，再做路由；不要凭感觉默认最大模型。
- 缓存、批处理和并行必须保持语义正确、权限隔离和失效策略。
- 对配额耗尽、成本异常、循环失控和供应商故障设置告警与自动止损。

### Release 与 Operations

- PR、CI、Artifact、部署、Smoke、Eval、Tag、Release 和回滚点可追踪到同一版本。
- Runbook 覆盖暂停 Agent、撤销凭证、禁用工具、回滚版本、恢复状态和通知责任人。
- 明确 SLO、告警 Owner、值班/升级路径和事故复盘机制。
- 生产变更采用影子、灰度或受限租户，风险越高，曝光半径越小。

---

## 13. 团队采用等级

| 等级 | 工作方式 | 进入下一等级的门槛 |
|---|---|---|
| L0 AI Pairing | 人主导，Agent 解释/生成局部代码 | 能稳定跑测试、看 Diff、保护密钥 |
| L1 Contracted Delivery | Contract + 垂直切片 + CI 证据 | 可复现交付，无聊天依赖 |
| L2 Recoverable Loop | 外部状态 + 独立 Evaluator + Stop Rule | 中断可恢复，失败能进入反馈回路 |
| L3 Governed Agentic Workflow | Harness/Loop/Graph + Policy + HITL | 权限、审批、审计、评测和回滚完整 |
| L4 Operated Enterprise System | 在线 Eval、SLO、成本、事故和数据治理 | 能长期运营并证明风险在可接受范围 |

团队不应以“用了多少 Agent”衡量成熟度，而应以可复现、可恢复、可观察、可控制和可追责衡量。

---

## 14. 参考来源与可移植性说明

本方法论的规范性结论保持框架和云厂商中立。以下材料用于校正概念与生产边界：

- ResolveWeave 的真实版本交付、RAG、安全加固、CI/E2E/Eval 和发布实践。
- Ronan 知识库中的《Agent Loop 工作协议模板》《Loop Engineering：Prompt → Context → Harness → Loop》《Agent Harness Engineering vs Loop Engineering vs Graph Engineering》《Context vs. Memory Engineering in Agentic AI Systems》《做完一次总体设计后，我重新理解了企业级知识库》等教程与实践笔记。
- Microsoft 官方课程 [AI Agents for Beginners](https://github.com/microsoft/ai-agents-for-beginners)，重点参考 Tool Use、Trustworthy Agents、Production Observability & Evaluation、Agentic Protocols、Context Engineering、Agent Memory、Scalable Deployment 和 Securing Agents。
- 同步学习副本：[Rcloudso/ai-agents-for-beginners](https://github.com/Rcloudso/ai-agents-for-beginners)。v3.0 编写时，关键章节与微软上游对应文件内容一致。

微软课程中的 Azure Foundry 和 Microsoft Agent Framework 是实现示例，不是本方法论的强制依赖。相同原则可映射到自托管服务、其他云平台、其他 Agent SDK 或普通后端工作流。

---

## 最终思想

> 用 Vibe 找方向，用 Contract/Policy 防漂移和越权，用 Context/Memory 控制 Agent 知道什么，用 Harness/Loop/Graph 控制 Agent 如何行动，用 Eval/Observability 持续判断效果，用 Security/HITL 守住责任边界，用 Git/CI/CD 把“感觉完成”变成“可以证明、可以发布、可以运营”。

v2 把“可以证明完成”落实到仓库与 CI；v3 再向生产推进一步：

- 开发前能说明为什么做、谁负责、什么风险不可接受；
- 执行中能限制上下文、权限、工具、成本、轮数和流程边；
- 发布前能用确定性测试、离线 Eval、对抗验证和部署 Smoke 证明质量；
- 上线后能通过 Trace、业务指标、在线反馈、告警和回滚持续运营；
- 出现事故时能还原版本、动作、审批和证据，并把真实失败变成下一轮测试。

企业级 Vibe Coding 的目标不是让 Agent 写更多代码，而是让组织以更低的试错成本、更清晰的责任边界和更短的反馈周期交付可信软件。
