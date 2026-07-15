# Routing guide: category-first task matching and legacy complexity grounding

Category routing is the normal path. Read the live taxonomy from the board, match the work against its
classifier descriptions, stamp the narrowest category, and trust the returned route and `exec` object.
This guide helps choose among live categories when their descriptions leave genuine ambiguity. It also
documents the fixed read-time mapping for tickets that still have only a legacy complexity score.

## Model and effort guidance

From Anthropic's [Choosing the right model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model),
[Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), and
[Effort](https://platform.claude.com/docs/en/build-with-claude/effort):

| Runtime | Useful shape when classification is unclear | Effort guidance |
|---|---|---|
| **haiku** | A tightly specified, mechanical subtask where the executor discovers nothing | No effort parameter |
| **sonnet** | Daily coding work against a known pattern, scoped bugfixes, and one-area features | Usually `high`; `low` fits high-volume or latency-sensitive work |
| **opus** | Multi-file features, shared contracts, cross-cutting refactors, and complex agentic coding | Usually `high`; `xhigh` is the documented starting point for coding and agentic work |
| **fable** | Root-cause investigations, architecture decisions, and work larger than one sitting | Start with `high`; use `xhigh` for capability-sensitive work |

`max` is for genuinely frontier problems and should stay rare. Effort is a category route field, not a
second classification system. The live category description and contract remain authoritative over this
general guidance.

## Legacy complexity bands

Complexity is retained for old tickets and for filings where category classification is genuinely
ambiguous. At read time, the fixed bands map to categories:

- **1–3** maps to `coding.easy`.
- **4–6** maps to `coding.normal`.
- **7–10** maps to `coding.hard`.

The mapped category supplies the concrete model, effort, contract, and fallback chain. The mapping is a
read projection only, so it does not rewrite the ticket's stored category. A ticket with neither category
nor complexity remains unclassified and cannot be dispatched until someone classifies and updates it.

## Fallback and dispatch

A category resolves its configured route first when that model is available, then its optional fallback,
then the global routing fallback, then hardwired Sonnet/high. A missing model can therefore produce a
degraded route and warning. The dispatcher does nothing special for that warning: it trusts the `exec`
object from the fresh `list` or `ready` read.

The `exec` projection names the exact executor and concrete model. Claude routes expose `exec.model`; Codex
routes expose a backend-specific `exec.agent` with `exec.model` null, so spawn that exact agent with the
`model` parameter omitted. Inject the category contract verbatim alongside the ticket contract. Never
hand-pick a model or effort after reading the route.

## Sources

- Choosing the right model — platform.claude.com/docs/en/about-claude/models/choosing-a-model
- Models overview — platform.claude.com/docs/en/about-claude/models/overview
- Effort — platform.claude.com/docs/en/build-with-claude/effort
- Claude Code model configuration — code.claude.com/docs/en/model-config
- Create custom subagents — code.claude.com/docs/en/sub-agents
