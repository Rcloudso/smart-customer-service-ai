# Smart Customer Service AI Roadmap

This roadmap describes the product direction rather than fixed delivery dates. The project is evolving from an FAQ-based MVP into a deployable, traceable RAG customer-service platform and, later, a guarded customer-service agent.

本路线图描述产品演进方向，不承诺固定发布日期。项目将从 FAQ MVP 逐步发展为可部署、可追溯的 RAG 智能客服，并在具备安全边界后扩展为能够调用业务工具的客服 Agent。

| Version | Status | Theme | Intended outcome |
| --- | --- | --- | --- |
| v0.2.4 | Released | Retrieval Evaluation & Debugging | FAQ 检索可评测、可解释，并在 CI 中执行浏览器回归。 |
| v0.2.5 | Released | Knowledge Gap Feedback Loop | 低质量回答进入知识审核，管理员可将其沉淀为已索引 FAQ。 |
| v0.2.6 | Released | Document RAG Foundation | 支持文本、Markdown、含文本层 PDF 和 DOCX 的上传、语义切片、索引、检索与无 Key 原文回退。 |
| v0.2.7 | Planned | Grounding & Citations | 回答展示来源与引用，无可靠依据时拒答或转人工。 |
| v0.2.8 | Planned | RAG Quality Lab | 增加重排、阈值调优、评测集版本和效果对比。 |
| v0.2.9 | Planned | OCR & Image Knowledge | 支持扫描件、截图 OCR，并为需要视觉理解的图片建立独立处理路径。 |
| v0.3.0 | Planned | Customer Service Agent | 通过受控工具完成订单、物流、退款等业务查询或动作。 |
| v0.3.1 | Planned | Human Collaboration | 增加人工接管、处理队列、内部备注和结果回流。 |
| v0.4.0 | Planned | Enterprise Readiness | 增加多知识库、权限、审计、迁移、备份和监控能力。 |

## Product Principles

- FAQ is the first knowledge source, not the permanent RAG boundary.
- SQLite and the local fallback remain the default low-dependency path until measured scale requires more infrastructure.
- RAG answers must become grounded and traceable before autonomous business actions are introduced.
- Human review, evaluation and guardrails are product features, not optional cleanup work.
- Each release should include a real scenario, verification evidence, known limitations and bilingual documentation.

## Contributing

Public contributors should use this file for direction and the release notes under `docs/releases/` for shipped behavior.
