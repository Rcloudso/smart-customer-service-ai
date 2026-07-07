<!-- agent-loop-project:start -->
# AGENTS.md

## Agent Loop Policy

Use `agent-loop/` only for complex work: multi-step projects, risky changes, resumable tasks, quality-sensitive deliverables, or work that needs explicit verification.

Do not use Agent Loop for simple questions, tiny edits, one-off lookups, formatting tweaks, or tasks with obvious completion.

For complex tasks:

1. Act as planner first.
2. Initialize or refine `agent-loop/feature_list.json` and `agent-loop/contract.md`.
3. Stop for user confirmation before execution unless the user explicitly asked you to proceed autonomously.
4. Execute as generator against `contract.md`.
5. Verify as evaluator against `contract.md`; the generator must not be the sole judge of completion.
6. Keep `agent-loop/progress.md` and `agent-loop/log.md` current.

Stop and ask before account actions, payment, posting, messaging, deleting, submitting forms, or other high-risk writes.
<!-- agent-loop-project:end -->
