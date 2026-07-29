# ResolveWeave Roadmap

This roadmap describes the product direction rather than fixed delivery dates. The project is evolving from an FAQ-based MVP into an enterprise-ready, traceable Agentic RAG customer-service product with guarded business tools and human collaboration.

本路线图描述产品演进方向，不承诺固定发布日期。项目将从 FAQ MVP 逐步发展为面向企业场景、可部署、可追溯的 Agentic RAG 智能客服，并在具备安全边界后扩展业务工具和人工协作。

## Current Baseline / 已实现基线

| Version | Status | Theme | Shipped outcome |
| --- | --- | --- | --- |
| v0.2.4 | Released | Retrieval Evaluation & Debugging | FAQ 检索可评测、可解释，并在 CI 中执行浏览器回归。 |
| v0.2.5 | Released | Knowledge Gap Feedback Loop | 低质量回答进入知识审核，管理员可将其沉淀为已索引 FAQ。 |
| v0.2.6 | Released | Document RAG Foundation | 支持 TXT、Markdown、含文本层 PDF 和 DOCX 的上传、语义切片、FAQ/文档混合检索、来源快照与无 Key 原文回退。 |
| v0.2.7 | Released | Grounding, Citations & Refusal | 在生成前确定 FAQ 直答、基于证据生成或拒答，持久化来源，并将冲突与高风险业务请求转人工。 |
| v0.2.8 | Released | RAG Quality Lab | 用版本化评测集比较检索与 Grounding 策略，并通过质量门禁安全发布和回滚。 |
| v0.2.9 | Released | Structured Escalation & Triage | 以结构化交接包、确定性优先级和只读双语分流页承接转人工流程。 |
| v0.3.0 | Released | Structure-Aware Ingestion Foundation | 统一结构表示、质量门禁、结构切片、处理时间线和显式影子重处理已公开发布。 |
| v0.3.1 | Released | Multimodal Knowledge Review | PNG/JPEG/WebP/扫描 PDF 经持久化 PaddleOCR 队列进入可编辑复核草稿；可选 DeepSeek 影子对照，发布后保留引擎、页码和 Block 来源。 |
| v0.3.2 | Current | Qdrant & Retrieval Observability | 可选 Qdrant、可恢复索引任务、Quality Lab 后端影子评测、alias 原子激活/回滚和八阶段检索 Trace 形成独立运维闭环。 |

v0.3.2 已经形成可运行且带回答边界、结构化人工交接和检索运维的小规模客服产品基线：用户聊天、匿名会话历史、FAQ
与文档知识、混合检索、可选 Qdrant、可恢复索引、检索 Trace、转人工记录、满意度、知识审核、会话分析、双语后台、
可信回答决策、来源持久化、接口幂等、防重复提交、Docker、检索评测和 Playwright 回归在同一工程内闭环。后续版本不再以增加
“另一个聊天 Demo”为目标，而是先补齐企业知识工程与 Agentic Retrieval，再扩展业务处理和人工协作。

## Planned Sequence / 计划顺序

| Version | Theme | Intended outcome |
| --- | --- | --- |
| v0.3.3 | Bounded Agentic Retrieval | LLM 在预算内选择、组合和重试检索工具；确定性 Grounding Gate 决定引用、拒答、转人工和答案放行。 |
| v0.3.4 | Enterprise Knowledge Operations | 增加可观测入库任务、文档版本、重建索引、失败恢复、白名单远程来源和定时刷新。 |
| v0.3.5 | Read-Only Customer Service Tools | 以 mock 订单/物流查询验证类型化工具和外部订单系统接口，不执行业务写操作。 |
| v0.3.6 | Human Collaboration | 增加人工接管、处理队列、分配、内部备注、解决结果和知识回流。 |
| v0.3.7 | Persistent Customer Identity & Memory | 在统一身份、明确同意、保留期限和删除能力之上提供结构化长期上下文。 |
| v0.3.8 | Controlled Business Actions | 在身份、确认、权限、策略、幂等和审计边界内处理退款申请等受控写操作。 |
| v0.4.0 | Enterprise Control Plane | 增加多知识库、租户与 RBAC、完整审计、模型容错、备份恢复、迁移和生产监控证据。 |

## Release Outcomes And Boundaries

### v0.2.7 — Grounding, Citations & Refusal

- 为直接 FAQ 和生成回答定义明确的 answer mode、来源与引用契约。
- 文档引用至少定位到文档、切片和可用页码；会话与知识审核保留当时证据。
- 区分“没有证据”“证据较弱”“证据冲突”和“高风险业务请求”，采用确定性拒答或转人工策略。
- 保持现有 SSE 事件兼容，新来源字段继续可选。
- 不在本版本引入业务工具、网页采集、OCR 或外部向量数据库。

### v0.2.8 — RAG Quality Lab

- 版本化 FAQ、文档和混合知识评测集，记录基线与变更后指标。
- 为不同知识来源验证召回阈值、拒答阈值和来源多样性策略。
- 以可替换接口实验重排器；默认无 Key 路径仍可运行。
- 报告失败样例、指标变化、延迟和成本，而不是只报告“测试通过”。
- 不把未经评测的模型或向量库替换成默认基础设施。

### v0.2.9 — Structured Escalation & Triage

- 将转人工记录扩展为结构化交接包：摘要、类别、优先级、已确认事实、
  缺失信息、证据来源、升级原因、建议队列和下一步。
- LLM 可以提取候选字段，但优先级、风险标记和队列选择必须经过类型校验与确定性规则。
- 后台能够查看交接包和关联对话/检索证据，并保留现有 escalation 兼容字段。
- 不增加多 Agent 专家团队，也不在本版本完成实时人工回复。

### v0.3.0 — Structure-Aware Ingestion Foundation

- 定义版本化的文档中间表示，至少覆盖文本、标题、列表、表格、键值、
  图片引用、页码、阅读顺序、边界框和来源信息。
- 按 MIME/内容能力路由解析器，经过规范化、清洗、质量评分后再进入切片，
  不让每种格式直接生成互不兼容的 Chunk。
- 按内容结构选择切片策略；表格保留表头与单元格关系，标题层级和图片引用
  不因纯文本拍平而丢失。
- 保存入库任务、阶段状态、错误码、解析器版本、文档表示版本和索引状态，
  低质量内容进入复核或拒绝，不静默发布。
- 首版只承诺通用知识检索，不承诺发票、合同等领域字段抽取。
- 保持现有 TXT、Markdown、文本 PDF、DOCX、SQLite 和无 Key 路径兼容。

### v0.3.1 — OCR, Tables & Image Knowledge

- 扫描 PDF、PNG、JPEG 和 WebP 通过持久化 SQLite 任务队列交给外部
  PaddleOCR/PP-StructureV3 Worker；保留原文件、页码、区域、识别置信度、
  任务与引擎版本。
- Paddle 输出只创建版本化复核草稿；管理员可逐 Block 修正文本、标题、
  列表、表格和键值结构，完整草稿通过质量门禁后才能原子发布。
- DeepSeek-OCR-2 作为可选影子输出独立保存和比较，不能覆盖 Paddle 结果或
  自动发布。
- 失败、低置信、资源超限、中断恢复和重试关系可检查；发布后的检索来源保留
  文档、页码、Block、任务和引擎版本。
- 原始图片的自由视觉问答、多模态 embedding、分布式队列和领域字段自动化
  明确留在本版本范围外。

### v0.3.2 — Qdrant & Retrieval Observability

- Qdrant 已作为异步 `VectorStore` 后的可选生产后端；内存实现继续服务
  fresh-clone 和无基础设施演示，SQLite 始终是知识权威源。
- 保留关键词/结构化检索；Qdrant 超时或不可用会记录 `degraded` Trace，
  不静默重建内存向量。
- 版本化 collection 通过固定批次、知识指纹和检查点支持中断恢复；就绪前
  校验 profile、维度、点数和当前知识指纹。
- Quality Lab 可用同一数据集和策略影子对比 memory/Qdrant；质量门禁通过后
  原子切换 alias，并可回滚到上一已验证 collection。
- 独立双语检索运维页展示健康、索引任务和固定八阶段 Trace；Trace 只保存
  有界安全元数据，默认保留 30 天。

### v0.3.3 — Bounded Agentic Retrieval

- 将查询分析、改写、拆解、知识源选择、检索、重排和证据评估暴露为
  类型化受限工具。
- Agent 必须受最大轮数、模型调用数、候选数、上下文、延迟和成本预算约束。
- 每一步记录输入摘要、工具、结果引用、分数和停止原因，支持回放与评测。
- Agent 只能提出证据集合；确定性 Grounding Gate 继续决定证据是否充分、
  是否引用、拒答、转人工和答案放行。
- 无 Key 路径继续使用确定性单轮检索，不因 Agent 不可用而破坏基础问答。

### v0.3.4 — Enterprise Knowledge Operations

- 将固定、项目自有的入库阶段做成可观测任务，不先建设通用低代码编排器。
- 支持文档版本、增量更新、重建索引、失败恢复、停用/回滚和来源新鲜度。
- 网页与远程文档仅允许白名单来源，保存快照、审核状态、版本和刷新记录；
  外部内容始终按不可信输入处理。

### v0.3.5 — Read-Only Customer Service Tools

- 只选择一个可验证的垂直场景：订单状态和物流查询。
- 没有真实订单系统时使用可替换 mock adapter，同时冻结外部订单系统
  request/result、错误、超时、授权和审计接口。
- LLM 只生成类型化工具请求；服务端负责身份/归属、参数、权限、超时、
  重试、响应裁剪和审计。
- 工具失败或结果不确定时安全降级为解释、补充信息请求或结构化转人工。
- 不执行退款、取消订单、修改地址等写操作。

### v0.3.6 — Human Collaboration

- 提供待处理队列、分配/认领、内部备注、处理状态、解决结果和处理时长。
- 人工坐席接收 v0.2.9 的结构化交接包，而不是重新阅读全部对话才能开始处理。
- 人工解决结果可以转为知识审核输入，但必须经过管理员确认后才进入知识库。
- 明确机器人回答、人工回复和系统事件的身份及审计边界。

### v0.3.7 — Persistent Customer Identity & Memory

- 在跨会话身份、同意、访问审计、保留期限和删除能力之上保存结构化客户事实。
- 不把全部对话自动写入长期向量记忆，也不把匿名浏览器状态视为客户身份。
- 客户能够查看、更正和删除长期记忆。

### v0.3.8 — Controlled Business Actions

- 从一个低风险、可回滚或需审批的动作开始，例如创建退款申请，而不是自动打款。
- 执行前展示结构化确认，执行时校验业务规则、权限、幂等键和当前状态。
- 保存请求、审批、执行结果和补偿动作审计；模型输出不得直接写数据库或调用支付。
- 高金额、证据不足、状态冲突和重复请求必须停止并转人工。

### v0.4.0 — Enterprise Control Plane

- 增加多知识库、租户隔离、细粒度 RBAC、完整审计、备份恢复、迁移和生产可观测性。
- 在存在多个真实模型候选后增加健康检查、熔断和故障切换，不提前堆叠模型路由。
- 完成 fresh-clone、升级迁移、租户隔离、故障恢复和真实部署证据后，
  再评估 1.0 稳定性承诺。
- 语音等新渠道作为现有会话、检索、工具和人工协作链路的适配器进入后续候选，
  不复制平行产品栈。

## Adoption Rules / 借鉴原则

- 借鉴“对话 → 结构化状态 → 确定性规则/工具 → 人工交接”的产品模式，
  不因示例使用某个 Agent 框架、记忆库或向量库就整体迁移技术栈。
- 借鉴 RAGent 的结构化文档表示、可观测入库阶段、独立检索通道、后处理链、
  检索预算和 Trace；不照搬其 Java 技术栈或 PostgreSQL、Redis、RocketMQ、
  Milvus、Neo4j 等完整基础设施。
- 优先扩展现有 service、repository、`KnowledgeRetriever` 和 `VectorStore`
  边界；只有出现第二个真实调用方或基础设施规模证据时才增加新抽象。
- 一个类型化路由器或工具能够解决的问题，不引入多 Agent 团队。
- 语音、网页和长期记忆都必须复用同一套安全、证据、会话和人工协作边界。

## Open-Source Adoption Track / 开源采用路线

Star 是关注度和传播结果，不是企业可用性的质量门禁。产品版本继续以用户结果
和验证证据为准，同时独立推进以下采用工作：

- 将 README 首屏从 “full-stack demo” 更新为清晰的企业客服价值主张，同时
  保留 pre-1.0 和已知限制，不用“企业级”掩盖未完成能力。
- 每个版本提供一个可识别的客服场景、最新短演示、关键截图、架构图、评测
  结果和失败边界，避免演示长期停留在旧版本。
- 提供一条无需外部 Key 的最短 quickstart、内置示例知识包和
  “上传文档 → 提问 → 查看引用/转人工”的首次成功路径。
- 维护适合首次贡献者的有边界 Issue、开发文档和架构决策，并补充准确的
  GitHub topics 与中英文搜索关键词。
- 同时观察 clone-to-first-answer 时间、安装失败率、Demo 完成率、Issue/PR
  参与和 Star，而不是把 Star 作为唯一目标。

## Product Principles

- FAQ is the first knowledge source, not the permanent RAG boundary.
- SQLite remains the business system of record and the local fallback remains
  the default low-dependency path; Qdrant is an optional first-class production index.
- RAG answers must become grounded and traceable before autonomous business actions are introduced.
- Agentic Retrieval may choose and repeat retrieval tools, but it cannot bypass deterministic grounding, authorization or audit gates.
- Read-only tools must be proven before write actions, and write actions require confirmation, idempotency and audit.
- Long-term customer memory requires identity, consent, retention and deletion controls.
- Human review, evaluation and guardrails are product features, not optional cleanup work.
- New channels must reuse the existing customer-service workflow rather than create parallel product stacks.
- Each release should include a real scenario, verification evidence, known limitations and bilingual documentation.

## Contributing

Public contributors should use this file for direction and the release notes under `docs/releases/` for shipped behavior.
