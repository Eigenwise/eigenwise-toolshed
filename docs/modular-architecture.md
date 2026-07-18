# Modular toolshed architecture

The toolshed has independent plugins that can share small, file-based integration points when needed.

`codex-gateway` publishes its discovered model catalog under `~/.claude/codex-gateway/catalog.json`. Sidequest reads that catalog when it resolves a ticket category. The catalog adds available models. It does not replace Sidequest category policy or fallback rules.

## Sidequest routing

Sidequest owns category routing end to end. Each ticket category carries executor guidance plus a primary model and effort. When the primary route cannot run, Sidequest tries the category fallback, the global fallback, then `sonnet/high`. It records unavailable routes as warnings on the ticket.

Sidequest keeps its category policy in its central store at `~/.claude/sidequest`, keyed by project path. Project-specific category rows can add, override, detach, disable, or reset the effective shared policy. The Sidequest CLI, MCP tools, dashboard, and executor dispatch all use this one resolver.

The installed plugin breadcrumb convention remains generic: plugins may write metadata below `~/.claude/toolshed/registry/<plugin>.json` for a known consumer to read. Consumers validate the advertised shape and never walk the plugin cache. Sidequest's own registry-writer hook is part of that convention.
