# Eigenwise Toolshed docs

This is the [Astro Starlight](https://starlight.astro.build/) documentation site for Eigenwise Toolshed.

```text
npm ci
npm run dev
npm run build
npm run check
npm run screenshots
```

`dev` and `prebuild` run `npm run generate` first. `docs/scripts/generate-reference.mjs` rebuilds
`src/content/docs/reference/` from plugin manifests, skill frontmatter, hooks, and the marketplace
file. Those reference pages are generated output, so never edit them by hand. Edit the source
manifest or generator instead.

The screenshot command runs `docs/screenshots/capture.mjs`. It seeds an isolated Sidequest board with
fixed synthetic records, starts disposable local services, and captures six images into
`src/assets/screenshots/`. The fixture privacy gate rejects environment-derived paths and usernames.
Never capture a live board or dashboard for committed docs images.

`npm run build` type-checks and builds the static site into `dist/`. The `docs.yml` workflow deploys
that directory to GitHub Pages after a push to `main` when docs, the docs workflow, or reference
sources under `plugins/` and `.claude-plugin/marketplace.json` changed. It can also run manually.
