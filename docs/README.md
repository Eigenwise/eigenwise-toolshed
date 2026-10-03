# Eigenwise Toolshed docs

This is the [Astro Starlight](https://starlight.astro.build/) documentation site for Eigenwise Toolshed.

```text
npm ci
npm run dev
npm test
npm run build
npm run check
npm run screenshots
```

`npm test` checks prose links into the generated reference routes and regenerates the reference pages while it runs. `dev` and `prebuild` also run `npm run generate` first. `docs/scripts/generate-reference.mjs` rebuilds
`src/content/docs/reference/` from plugin manifests, skill frontmatter, hooks, and the marketplace
file. Those reference pages are generated output, so never edit them by hand. Edit the source
manifest or generator instead.

The screenshot command runs `docs/screenshots/capture.mjs`. It seeds an isolated Sidequest board with
fixed synthetic records, starts disposable local services, and captures fourteen images into
`src/assets/screenshots/`. The fixture privacy gate rejects environment-derived paths and usernames.
Never capture a live board or dashboard for committed docs images.

`npm run build` type-checks and builds the static site into `dist/`. The `docs.yml` workflow deploys
that directory to GitHub Pages after a push to `main` when docs, the docs workflow, or reference
sources under `plugins/` and `.claude-plugin/marketplace.json` changed. It can also run manually.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../plugins/sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
