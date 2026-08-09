---
title: Contributing to the docs
description: Maintainer workflow for changing plugin source and site documentation.
---

## Maintainer overview

The site has two documentation surfaces:

- **Generated reference:** Pages under `docs/src/content/docs/reference/` come from plugin manifests, skill frontmatter, hook registries, binaries, and marketplace metadata. Change the source input or generator, then regenerate. Never hand-edit these pages.
- **Prose guides:** The setup, observability, architecture, contributing, and release pages are maintained by hand. Update them when a user workflow or maintainer workflow changes.

Keep user actions in the [getting started guide](./getting-started/) or the relevant plugin guide. Keep implementation boundaries and release mechanics on the maintainer pages.

## Build the site

From `docs/`, install dependencies and build:

```text
npm ci
npm run build
```

The build regenerates the reference pages before Astro checks and builds the site. Run `npm run screenshots` when a committed documentation screenshot needs updating. The screenshot pipeline uses synthetic fixtures and isolated local services.

For plugin-specific contracts, read that plugin's `README.md` before changing a guide. Source changes and documentation changes should land together when the user-visible workflow changes.

See [release process](./release-process/) for publishing changes.
