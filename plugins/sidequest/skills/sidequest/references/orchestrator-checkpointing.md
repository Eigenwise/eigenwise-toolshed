# Orchestrator checkpointing

Use this when a session-start reminder enters checkpoint mode.

## The rule

State your read and proceed by default when evidence is incomplete or a conclusion is inferred. Ask only before an inference would be expensive to reverse:

- Shipping a user-facing behavior or public contract.
- Deleting data, refs, or branches.
- Spending money or quota that cannot be recovered.
- Locking in a decision other work will build on before it can be revisited.

Examples that should trigger a checkpoint:

- Publishing an inferred change that alters user behavior.
- Deleting refs or branches based on an incomplete cleanup scan.
- Committing an inferred platform boundary that dependent work will immediately rely on.

Examples that should state the assumption and proceed:

- Updating a category description from a reasonable read of the current setup.
- Changing a route assignment or config value that can be corrected in a follow-up.

Examples that should not trigger one:

- Filing a routine ticket.
- Executing an exact user specification.
- A mechanical change contained in one project.

When a confirmation is needed, state the evidence, the proposed decision, what remains uncertain, and the smallest confirmation needed. Keep delegating and working normally otherwise.

## Model signal and limits

Claude Code documents `model` as an optional `SessionStart` input field. Sidequest checks that snapshot only for Sonnet and Haiku names, treating Fable and Opus as higher tiers. The ordering is an operating assumption, not a capability guarantee.

`UserPromptSubmit` does not receive a model field. A SessionStart snapshot can be absent and does not update after an in-place `/model` switch, so absent or unrecognized values emit no tier-specific reminder. `CLAUDE_CODE_SUBAGENT_MODEL` chooses a subagent model. It does not reveal or control the main orchestrator model.

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [custom subagents](https://code.claude.com/docs/en/sub-agents).

## Why this is conditional

The shipped behavior uses the documented SessionStart snapshot rather than an always-on warning. A user-set board flag could cover model changes made after SessionStart, but it would add setup, can go stale, and needs CLI, MCP, and board-display support. An unconditional version is simpler but would nag higher-tier sessions. Revisit a board flag only if missed mid-session model switches become a practical problem.
