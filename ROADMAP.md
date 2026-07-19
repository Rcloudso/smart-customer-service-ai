# Smart Customer Service AI Roadmap

This roadmap describes the product direction rather than fixed delivery dates. The project is evolving from an FAQ-based MVP into a deployable, traceable RAG customer-service platform and, later, a guarded customer-service agent.

本路线图描述产品演进方向，不承诺固定发布日期。项目将从 FAQ MVP 逐步发展为可部署、可追溯的 RAG 智能客服，并在具备安全边界后扩展为能够调用业务工具的客服 Agent。

## Current Baseline / 已实现基线

| Version | Status | Theme | Shipped outcome |
| --- | --- | --- | --- |
| v0.2.4 | Released | Retrieval Evaluation & Debugging | FAQ 检索可评测、可解释，并在 CI 中执行浏览器回归。 |
| v0.2.5 | Released | Knowledge Gap Feedback Loop | 低质量回答进入知识审核，管理员可将其沉淀为已索引 FAQ。 |
| v0.2.6 | Released | Document RAG Foundation | 支持 TXT、Markdown、含文本层 PDF 和 DOCX 的上传、语义切片、FAQ/文档混合检索、来源快照与无 Key 原文回退。 |
| v0.2.7 | Current | Grounding, Citations & Refusal | 在生成前确定 FAQ 直答、基于证据生成或拒答，持久化来源，并将冲突与高风险业务请求转人工。 |

v0.2.7 已经形成可运行且带回答边界的小规模客服产品基线：用户聊天、匿名会话历史、FAQ
与文档知识、混合检索、转人工记录、满意度、知识审核、会话分析、双语后台、
可信回答决策、来源持久化、Docker、检索评测和 Playwright 回归在同一工程内闭环。后续版本不再以增加
“另一个聊天 Demo”为目标，而是依次补齐可信度、业务处理和人工协作。

## Planned Sequence / 计划顺序

| Version | Theme | Intended outcome |
| --- | --- | --- |
| v0.2.8 | RAG Quality Lab | 用版本化评测集、阈值实验和可选重排器持续验证检索与回答质量。 |
| v0.2.9 | Structured Escalation & Triage | 把简单转人工记录升级为结构化交接包，并通过确定性规则完成优先级和队列路由。 |
| v0.3.0 | Read-Only Customer Service Tools | 以订单/物流查询为首个受控工具闭环，只读接入真实或可替换的业务 API。 |
| v0.3.1 | Human Collaboration | 增加人工接管、处理队列、分配、内部备注、解决结果和知识回流。 |
| v0.3.2 | Controlled Business Actions | 在确认、权限、策略、幂等和审计边界内处理退款申请等写操作。 |
| v0.3.3 | Web Knowledge Source | 通过白名单抓取、快照、审核、版本和来源追踪导入网页知识。 |
| v0.3.4 | OCR & Image Knowledge | 支持扫描件和截图 OCR，并为必须视觉理解的图片建立独立处理路径。 |
| v0.3.5 | Persistent Customer Identity & Memory | 在统一客户身份、明确同意、保留期限和删除能力之上提供结构化长期上下文。 |
| v0.3.6 | Voice Channel | 增加语音输入输出适配器，复用现有会话、检索、工具和转人工链路。 |
| v0.4.0 | Enterprise Readiness | 增加多知识库、角色权限、租户边界、审计、迁移、备份、监控和按规模选用外部向量存储。 |

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

### v0.3.0 — Read-Only Customer Service Tools

- 只选择一个可验证的垂直场景：订单状态和物流查询。
- LLM 只生成类型化工具请求；服务端负责身份/归属、参数、权限、超时、
  重试、响应裁剪和审计。
- 使用工具范围内的已验证客户令牌、一次性校验或本地演示身份适配器，
  不把匿名浏览器状态当作查询真实订单的授权。
- 工具失败或结果不确定时安全降级为解释、补充信息请求或结构化转人工。
- 提供可替换的本地演示适配器，使没有第三方业务系统时仍能运行完整流程。
- 不执行退款、取消订单、修改地址等写操作。

### v0.3.1 — Human Collaboration

- 提供待处理队列、分配/认领、内部备注、处理状态、解决结果和处理时长。
- 人工坐席接收 v0.2.9 的结构化交接包，而不是重新阅读全部对话才能开始处理。
- 人工解决结果可以转为知识审核输入，但必须经过管理员确认后才进入知识库。
- 明确机器人回答、人工回复和系统事件的身份及审计边界。

### v0.3.2 — Controlled Business Actions

- 从一个低风险、可回滚或需审批的动作开始，例如创建退款申请，而不是自动打款。
- 执行前展示结构化确认，执行时校验业务规则、权限、幂等键和当前状态。
- 保存请求、审批、执行结果和补偿动作审计；模型输出不得直接写数据库或调用支付。
- 高金额、证据不足、状态冲突和重复请求必须停止并转人工。

### v0.3.3–v0.3.6 — Knowledge, Memory And Channel Adapters

- 网页知识必须白名单抓取、内容快照、人工审核、版本化和保留来源；外部内容按不可信输入处理。
- OCR 与图片理解独立于文本解析，保留原文件、页码和提取质量信息。
- v0.3.5 将工具范围内的身份校验扩展为跨会话统一客户身份；客户记忆只保存
  明确、结构化、可解释的客户事实，不把全部对话自动写入长期向量记忆。
- 客户必须能够查看、更正和删除长期记忆，并由身份、同意、保留期限和访问审计保护。
- 语音仅作为现有客服工作流的输入/输出适配器，不复制一套 RAG、工具或转人工实现。

### v0.4.0 — Enterprise Readiness

- 用测量结果决定是否接入 Qdrant、pgvector、后台任务或独立检索服务。
- 增加多知识库、租户隔离、细粒度 RBAC、完整审计、备份恢复、迁移和可观测性。
- 完成 fresh-clone、升级迁移、故障恢复和真实部署证据后，再评估 1.0 稳定性承诺。

## Adoption Rules / 借鉴原则

- 借鉴“对话 → 结构化状态 → 确定性规则/工具 → 人工交接”的产品模式，
  不因示例使用某个 Agent 框架、记忆库或向量库就整体迁移技术栈。
- 优先扩展现有 service、repository、`KnowledgeRetriever` 和 `VectorStore`
  边界；只有出现第二个真实调用方或基础设施规模证据时才增加新抽象。
- 一个类型化路由器或工具能够解决的问题，不引入多 Agent 团队。
- 语音、网页和长期记忆都必须复用同一套安全、证据、会话和人工协作边界。

## Product Principles

- FAQ is the first knowledge source, not the permanent RAG boundary.
- SQLite and the local fallback remain the default low-dependency path until measured scale requires more infrastructure.
- RAG answers must become grounded and traceable before autonomous business actions are introduced.
- Read-only tools must be proven before write actions, and write actions require confirmation, idempotency and audit.
- Long-term customer memory requires identity, consent, retention and deletion controls.
- Human review, evaluation and guardrails are product features, not optional cleanup work.
- New channels must reuse the existing customer-service workflow rather than create parallel product stacks.
- Each release should include a real scenario, verification evidence, known limitations and bilingual documentation.

## Contributing

Public contributors should use this file for direction and the release notes under `docs/releases/` for shipped behavior.
