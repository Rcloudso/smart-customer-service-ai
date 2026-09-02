# ResolveWeave Product Language

This context defines the product language used to distinguish evidence
retrieval from the safety decision that permits a customer-service answer.

## Language

**Agentic Retrieval**:
A bounded, traceable process in which an Agent plans and iterates over knowledge-retrieval capabilities to assemble evidence.
_Avoid_: Agentic RAG, autonomous answering

**Grounding Gate**:
The deterministic product policy that decides whether assembled evidence permits an answer, requires refusal, or requires human escalation.
_Avoid_: Agent judgment, confidence guess
