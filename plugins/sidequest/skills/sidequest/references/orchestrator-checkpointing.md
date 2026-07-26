# Orchestrator checkpointing

Use this when a session-start reminder enters checkpoint mode.

## The rule

Ask before encoding a judgment call when both conditions hold:

1. The evidence is incomplete or the conclusion is inferred.
2. The decision is irreversible, cross-project, or broadly scoped.

Examples that should trigger a checkpoint:

- Defining or changing category and route rules from partial codebase evidence.
- Writing configuration that changes behavior in other projects.
- Choosing a broad module boundary from names or a shallow scan.

Examples that should not trigger one:

- Filing a routine ticket.
- Executing an exact user specification.
- A mechanical change contained in one project.

State the evidence, the proposed decision, what remains uncertain, and the smallest confirmation needed. Keep delegating and working normally otherwise.

## Model signal and limits

Claude Code documents `model` as an optional `SessionStart` input field. Sidequest checks that snapshot only for Sonnet and Haiku names, treating Fable and Opus as higher tiers. The ordering is an operating assumption, not a capability guarantee.

`UserPromptSubmit` does not receive a model field. A SessionStart snapshot can be absent and does not update after an in-place `/model` switch, so absent or unrecognized values emit no tier-specific reminder. `CLAUDE_CODE_SUBAGENT_MODEL` chooses a subagent model. It does not reveal or control the main orchestrator model.

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [custom subagents](https://code.claude.com/docs/en/sub-agents).

## Why this is conditional

The shipped behavior uses the documented SessionStart snapshot rather than an always-on warning. A user-set board flag could cover model changes made after SessionStart, but it would add setup, can go stale, and needs CLI, MCP, and board-display support. An unconditional version is simpler but would nag higher-tier sessions. Revisit a board flag only if missed mid-session model switches become a practical problem.
