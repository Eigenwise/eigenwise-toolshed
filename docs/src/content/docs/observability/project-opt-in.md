---
title: Per-project opt-in
description: Enable local telemetry only for the projects where it helps.
---

Telemetry is off until a project opts in. From that project directory, run:

```text
/workbench:enable-project-telemetry
```

Workbench writes private project settings, prepares its loopback observer and Collector, records the project in the local registry, and checks whether metrics arrive. The registry lets the global dashboard group data by project without copying project files anywhere.

Run the same skill to verify or disable telemetry. `/workbench:workbench-doctor` is read-only and checks the observer, collector, registry, and statusline path.

The global dashboard can show every opted-in project. A project view filters to the current project, so you can inspect one codebase without mixing its counts with the rest of your machine.
