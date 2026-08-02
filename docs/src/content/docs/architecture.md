---
title: Architecture
description: How the Toolshed pieces fit together on your machine.
---

Toolshed is a marketplace of seven independent Claude Code plugins: Workbench, Observability, Model Gateway, Sidequest, Codebase Mapper, Live Rules, and Playbook. Hooks run at Claude Code lifecycle points, local observers turn selected activity into counts, and the dashboard reads the resulting loopback data. Sidequest keeps tickets and dispatch policy in its own store. Model Gateway sits in front of the model API only when you choose a gateway model.

```mermaid
flowchart LR
  CC[Claude Code] --> H[Plugin hooks]
  H --> O[Observability observer]
  O --> C[Loopback Collector]
  C --> G[Local dashboard]
  CC --> S[Sidequest board + dispatch]
  S --> E[Executors]
  CC --> W[Model Gateway shim]
  W --> P[Local proxy]
  P --> API[Claude or Codex backend]
```

See [modular toolshed architecture](./architecture/modular-architecture/) for the file-based integration points and category routing rules.
