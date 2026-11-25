# No process per tool call

2026-11-16

**v1 had:** command hooks on PreToolUse and PostToolUse, each starting a node process, several of which also opened the board store and ran git.

**Evidence:** On 2026-10-08 six read-only executors produced 42 hook processes in a 25 second sample, each living 10 to 11.7 seconds. Every orchestrator board write and two worktree creations failed with "database is locked". One edit cost one node process and three git calls. The guards that cost this were not catching real damage (see shell-parsing-guards).

**Decision:** Hooks run in-process in the hooks module. Zero processes per tool call. No command hooks on PreToolUse, PostToolUse or UserPromptSubmit, and a structural test enforces it.

**Would change if:** the host removes in-process hooks.
