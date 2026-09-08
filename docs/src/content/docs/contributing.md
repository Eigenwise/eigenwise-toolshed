---
title: Contributing to the docs
description: Maintainer workflow for changing plugin source and site documentation.
---

## Maintainer overview

Keep each change in the documentation surface that owns it. There are three classes.

### Agent-facing contract

MCP tool schemas and descriptions, refusal and guidance strings, agent and skill definitions, CLI help, and live rules tell agents what the system does. Update these surfaces with the code change in the same story. When a value is enumerated in code, treat that enum as the source of truth and update every surface that repeats it.

### Generated reference

Pages under `docs/src/content/docs/reference/` are generated from plugin metadata, skill frontmatter, hook registries, bin file inventories, and marketplace metadata. Change the source input or `docs/scripts/generate-reference.mjs`, then regenerate with `npm run generate`. Never hand-edit a generated page.

### Human prose

Setup, observability, architecture, contributing, and release pages are maintained by hand. Update the affected page in the same story when a user or maintainer workflow changes. If the prose needs a larger follow-up, file a linked `docs-writing` ticket before the story ships.

Keep user actions in the [getting started guide](../getting-started/) or the relevant plugin guide. Keep implementation boundaries and release mechanics on the maintainer pages.

## Build the site

From `docs/`, install dependencies and build:

```text
npm ci
npm run build
```

The build regenerates the reference pages before Astro checks and builds the site. Run `npm run screenshots` when a committed documentation screenshot needs updating. The screenshot pipeline uses synthetic fixtures and isolated local services.

For plugin-specific contracts, read that plugin's `README.md` before changing a guide. Source changes and documentation changes should land together when the user-visible workflow changes.

See [release process](../release-process/) for publishing changes.
