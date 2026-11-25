# No worktree leases or custom worktree root

2026-11-16

**v1 had:** its own worktree creation, lease, provisioning, sweep, quarantine and salvage, plus a WorktreeCreate hook that took every worktree request in the session.

**Evidence:** `worktrees.ts` is 3,234 lines and the create hook 416, with guards that run on every edit. The hook had no matcher, so plain `Agent` calls and workflow agents with native isolation failed (#695). Edits inside an executor's own worktree were refused as "shared checkout" four times (#98, #163, #232, #840).

**Decision:** Use the host's native `isolation: "worktree"`. Cleanup is the host's job. Sidequest registers no WorktreeCreate hook.

**Would change if:** native isolation is shown to lose work, and a small setup step cannot fix it.
