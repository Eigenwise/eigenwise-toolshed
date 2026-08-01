---
title: Getting started
description: Install the marketplace, reload Claude Code, and start a workspace.
---

Eigenwise Toolshed is a Claude Code plugin marketplace. Start with these four steps:

1. Add the marketplace:

   ```text
   /plugin marketplace add Eigenwise/eigenwise-toolshed
   ```

2. Install Workbench for your user account:

   ```text
   /plugin install workbench@eigenwise-toolshed --scope user
   ```

3. Reload Claude Code so the new skills and hooks are discovered:

   ```text
   /reload-plugins
   ```

4. From the project you want to prepare, run:

   ```text
   /workbench:init-workspace
   ```

Step 4 installs and configures the other Toolshed plugins for that project. You do not need to install six plugins by hand.

Use these scopes when you install or configure plugins:

- Workbench is user-scoped because you want the workspace manager in every project.
- Model Gateway is required and user-scoped because its wiring is global.
- Every other plugin is project-scoped so its configuration travels with the repository.

Claude Code only loads a plugin at the reload boundary, so run `/reload-plugins` after installing or updating one.

## First workspace

With Workbench installed, run the workspace setup skill from the project you want to prepare:

```text
/workbench:init-workspace
```

It walks through project-side configuration, then writes the `.claude/` files the project selected. The setup interview also proposes a Sidequest routing profile after the repository scan. Codebases usually start with `coding`, docs and content with `writing`, source-heavy work with `research`, and audio or music projects with `creative-music`. Accept the proposal, choose another starter, or create a project-specific profile by cloning the closest starter and adjusting it. Setup never edits a shared starter profile.

Install `codebase-mapper` when you want a maintained map of the codebase, and `live-rules` when rules should be injected as prompts and edits happen. Live Rules stores new rules as individual Markdown files; after changing one, its `add-rule` or `manage-rules` skill runs the plugin-owned sync command to regenerate the hash manifest. When Sidequest is also installed and ready for bounded map artifacts, codebase-mapper tracks existing-project mapping there and leaves the generated map in the working tree for review.

For local usage data, opt in separately with `/workbench:enable-project-telemetry`. See [observability](./observability/) before enabling it.
