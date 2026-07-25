---
description: Release-owned manifest versions
globs: [".claude-plugin/marketplace.json", "plugins/*/.claude-plugin/plugin.json"]
---
- Version fields in these manifests are release-owned. Only `scripts/release/cut.mjs` writes them.
- Ticket integration writes a release fragment and pushes `dev`; do not edit manifest versions during ticket work.
- Non-version metadata edits remain normal ticket work.
