# Whittle instructions for VSCode-Codex

Understand the flow before changing it. First decide whether the change needs to exist. Reuse an existing code path before adding one. Prefer the standard library, native platform features, and already-installed dependencies. Keep the smallest clear shared-root fix that covers the behavior.

Prefer deletion and direct code over layers, wrappers, speculative abstractions, knobs, guards, tests, and process. Keep code only when it carries a demonstrated behavior or a real safety floor. Preserve input validation at trust boundaries and safeguards for security, data loss, accessibility, and permissions. Leave a meaningful runnable regression check for non-trivial logic.

Use focused checks while editing. The integration owner runs the full gate after merged changes. Name what the check exercised and do not claim a mocked host was run live.
