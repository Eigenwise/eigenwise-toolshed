---
title: Per-project opt-in
description: Enable, verify, or disable local usage telemetry for one repository.
---

Observability is opt-in per repository. From anywhere inside the repository, run:

```text
/observability:enable-project-telemetry
```

Approve the setup when Claude asks. It handles the machine-shared local services you selected, then wires this repository for the intended metadata-only Claude Code usage and checks for incoming metrics. A bare setup keeps SQLite only; `--dashboard` explicitly requests the Docker dashboard. The current hook and ingest path can accept hook events before checking repository opt-in, so treat the per-repository policy as intended rather than a hard runtime privacy guarantee until enforcement is fixed.

## What one opt-in covers

An opt-in wires the repository root and its eligible descendant directories. Native Claude Code metrics require telemetry settings in the exact directory where the session starts. Hook events from a linked worktree can still resolve to the enclosing main repository identity, but the repository opt-in does not promise native metrics for that linked-worktree session. Runtime coverage for that case is separate.

Settings changes apply to new Claude Code sessions. Restart existing sessions in every listed directory before creating activity or expecting their native metrics to appear. `/reload-plugins` alone does not apply the new environment. The restart reloads project wiring; an older session leaves a newer live observer untouched.

## Verify the first workflow

After restarting a session, create some activity, then run the same skill again and ask Claude to verify the project. The result is:

- `found` when the local setup has seen a Claude Code usage sample for the project.
- `not-found` when no sample has arrived yet or no dashboard is configured.

If it is still `not-found`, restart the listed session directories and create another small piece of activity. Then ask Claude to audit the project wiring.

## Disable one repository

Run the same skill and ask Claude to disable telemetry for the current repository. It unwires the settings environment, removes the repository from the opted-in registry, and stops native Claude Code metrics for new sessions, while leaving other opted-in repositories alone. Hook events can still reach a running observer after disable. Deleting history is a separate global cleanup of the shared local store, not a per-repository disable action.

The [dashboard guide](../dashboard/) explains how to read project and global views after verification.
