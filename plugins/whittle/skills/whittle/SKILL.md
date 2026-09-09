---
name: whittle
description: Optional session style modes for practical minimalism. Use for /whittle status, lite, full, ultra, off, or default mode changes.
---

# Whittle

Whittle is an optional style overlay. It changes how work is approached, never permissions, validation, data-loss protections, accessibility, or Sidequest integrity.

## Shared

Understand the flow before simplifying it. Start with necessity, existing code, the standard library, and native platform features. Fix the smallest shared root that covers the behavior. Keep meaningful runnable regression checks and real safety floors. Avoid speculative abstractions, guards, tests, and process.

## Lite

Use the smallest clear change that fits the established flow. Reuse before adding.

## Full

Apply the shared policy consistently. Prefer deletion and direct code over layers, wrappers, and new dependencies.

## Ultra

Question every addition. Keep only code that carries a demonstrated behavior or safety floor.

## Reports

Reports do not depend on the active Whittle mode. When Sidequest is installed, ask it for a readonly candidate review, named-scope repository audit, or source-comment debt scan. Sidequest owns the routing and never makes edits. A submitted candidate review needs its immutable `reviewTarget`; an audit reports concrete delete, reuse, standard-library, native-platform, YAGNI, or shrinking opportunities; debt reports cite file:line, ceiling, observable upgrade trigger, and replacement. It recognizes `ponytail:` and `whittle:` shortcut markers. Missing ceilings or triggers are findings, never invented details or permission to create a ledger.

If Sidequest is unavailable in the host, say the routed report capability is unavailable. Absolute Observability measurements are not causal gain, so report gain as unmeasured without a matched baseline. Do not reuse static headline figures or private workflow data.

## Commands

`/whittle [status|lite|full|ultra|off|default <mode>]` selects a session mode. `stop whittle` and `normal mode` turn the optional overlay off. `default <mode>` is an explicit, project-scoped default change.

Enabling Whittle or its host adapter is the opt-in. Mode changes persist when the host provides a session identity; Whittle reports a persistence failure instead of claiming the selection was saved. If Ponytail injection is active, disable it there and reload before enabling Whittle so the overlays do not stack. Whittle does not inspect registries or change Ponytail configuration.

Sidequest owns reports and audits. Whittle does not measure outcomes, so unmeasured gains are unmeasured. A statusline may call `bin/whittle-status.js --statusline --session <id> --project <path>` when the host exposes that session identity. Its explicit `--project` selects that project's mode even when `CLAUDE_PROJECT_DIR` names another project.
