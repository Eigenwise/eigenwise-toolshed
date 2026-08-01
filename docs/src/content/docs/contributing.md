---
title: Contributing and docs internals
description: Keep plugin source, generated reference pages, and site prose in sync.
---

The site has two documentation surfaces. Pages under `docs/src/content/docs/reference/` are generated from plugin manifests, skill frontmatter, hook registries, and the marketplace file. Fix their source inputs or the generator, then regenerate. Never hand-edit a generated reference page.

The setup guides, observability pages, architecture pages, and this page are prose. Update them when a plugin changes what users install, configure, or see. Keep the explanation in the existing guide when a topic fits there; add a page only when the topic has no useful home.

## Build and screenshots

From `docs/`, install dependencies and build the site:

```text
npm ci
npm run build
```

The deploy workflow regenerates reference pages when plugin manifests, skills, hooks, or marketplace data change. Documentation screenshots come from the committed synthetic pipeline under `docs/screenshots/`; run `npm run screenshots` when a screenshot needs updating. Do not capture live boards, dashboards, project names, session ids, or costs for committed docs.

The repository workflows also run the docs build and deploy checks. Their current release automation state is documented in `.github/README.md`; notification-only `v*` releases do not own marketplace versioning.

For plugin-specific source contracts, read the relevant directory README before changing a setup guide. Internal tools such as test helpers can be documented with a short pointer to their directory rather than an install guide.
