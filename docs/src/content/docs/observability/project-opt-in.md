---
title: Per-project opt-in
description: Enable, verify, or disable local usage telemetry for one repository.
---

Observability is opt-in per repository. From anywhere inside the repository, run:

```text
/observability:enable-project-telemetry
```

Approve the setup when Claude asks. It wires that repository for metadata-only Claude Code usage, starts the managed local services you selected, and checks for incoming metrics. You can keep the local report only, use the loopback dashboard, or choose a remote sink yourself.

## What one opt-in covers

An opt-in wires the repository root and its eligible descendant directories. It does not wire linked worktrees, sibling checkouts, or directories outside the repository. Native Claude Code metrics require telemetry settings in the exact directory where the session starts.

Settings changes apply to new Claude Code sessions. Restart existing sessions in the directories Claude lists before expecting their native metrics to appear. The restart reloads project wiring; an older session leaves a newer live observer untouched.

## Verify the first workflow

After restarting a session, create some activity, then run the same skill again and ask Claude to verify the project. The result is:

- `found` when the local setup has seen a Claude Code usage sample for the project.
- `not-found` when no sample has arrived yet or no dashboard is configured.

If it is still `not-found`, restart the listed session directories and create another small piece of activity. Then ask Claude to audit the project wiring.

## Disable one repository

Run the same skill and ask Claude to disable telemetry for the current repository. It stops collection for that repository by removing its wiring and registry entry, while leaving other opted-in repositories alone. Deleting history is a separate global cleanup of the shared local store, not a per-repository disable action.

The [dashboard guide](./dashboard/) explains how to read project and global views after verification.
