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

A repository includes its subdirectories and linked worktrees. Claude groups them under one project identity, so sessions started from a package or worktree still land in the same project view.

Settings changes apply to new Claude Code sessions. Restart existing sessions in the directories Claude lists before expecting their native metrics to appear.

## Verify the first workflow

After restarting a session, create some activity, then run the same skill again and ask Claude to verify the project. The result is:

- `found` when the local setup has seen a Claude Code usage sample for the project.
- `not-found` when no sample has arrived yet or no dashboard is configured.

If it is still `not-found`, restart the listed session directories and create another small piece of activity. Then ask Claude to audit the project wiring.

## Disable one repository

Run the same skill and ask Claude to disable telemetry for the current repository. It removes this repository's wiring and registry entry, leaves other opted-in repositories alone, and keeps local history unless you choose deletion.

The [dashboard guide](./dashboard/) explains how to read project and global views after verification.
