---
name: whittle
description: One practical clean-code policy applied automatically when Whittle is enabled.
---

# Whittle

Whittle applies one practical clean-code policy. It changes how work is approached, never permissions, validation, data-loss protections, accessibility, or Sidequest integrity.

## Clean-code policy

Understand the flow before changing it. First decide whether the change needs to exist. Reuse an existing code path before adding one. Prefer the standard library, native platform features, and already-installed dependencies. Keep the smallest clear shared-root fix that covers the behavior.

Prefer deletion and direct code over layers, wrappers, speculative abstractions, knobs, guards, tests, and process. Keep code only when it carries a demonstrated behavior or a real safety floor. Preserve input validation at trust boundaries and safeguards for security, data loss, accessibility, and permissions. Leave a meaningful runnable regression check for non-trivial logic.

Use focused checks while editing. The integration owner runs the full gate after merged changes. Name what the check exercised and do not claim a mocked host was run live.

## Reports

Whittle has no command and does not measure outcomes. When Sidequest is installed, ask it for a readonly submitted-candidate review, named-scope repository audit, or source-comment debt scan. Sidequest owns the routing and never makes edits. A submitted candidate review needs its immutable `reviewTarget`; an audit reports concrete delete, reuse, standard-library, native-platform, YAGNI, or shrinking opportunities; debt reports cite file:line, ceiling, observable upgrade trigger, and replacement. It recognizes `whittle:` shortcut markers. Missing ceilings or triggers are findings, never invented details or permission to create a ledger.

If Sidequest is unavailable, say the routed report capability is unavailable. For help, ask Sidequest to explain its read-only review, audit, or debt recipe. Absolute Observability measurements are not causal gain, so report gain as unmeasured without a matched baseline. Do not reuse static headline figures or private workflow data.

## Setup

Enable the Whittle Claude Code plugin to apply this policy automatically. Disable the plugin to remove it. If another clean-code injector is active, disable that injector manually and reload plugins or restart Claude Code before enabling Whittle so the policies do not stack. Whittle does not inspect registries, import preferences, or change another tool's configuration.
