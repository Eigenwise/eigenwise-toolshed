# Release fragments

`.release/unreleased/` is the queue of changes that have landed but are not published yet. One
file per ticket, written when the ticket integrates, consumed by the next release cut. It exists
because the board lives in `~/.claude/sidequest/sidequest.db`, which CI, forks, and a fresh clone
cannot read. The fragment is the part of that record the repository has to own.

Write one with `node scripts/release/note.mjs`, never by hand if you can avoid it, because the
script validates what it writes:

```bash
node scripts/release/note.mjs SQ-843 --title "Build the release engine" --plugins sidequest --bump minor --commit "$(git rev-parse HEAD)"
```

## Schema

`.release/unreleased/<REF>.md`, markdown with YAML frontmatter. The filename stem must equal the
`ref` field.

```markdown
---
ref: SQ-843
title: Build deterministic release planning and cut engine
bump: minor
plugins: [sidequest, workbench]
commit: c7b2702b2e2f041dff7fe513710de83d89198c55
---
Optional body. It shows up indented under the changelog entry, so use it for the one detail a
reader needs that the title cannot carry.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ref` | yes | Board ref, matching the filename. `SQ-843`, not `sq-843`. |
| `title` | yes | The changelog line. Write it for someone who did not work the ticket. |
| `plugins` | yes | Which published plugins this releases. A list, or a map of plugin to bump level. |
| `bump` | when `plugins` is a list | `patch`, `minor`, or `major`, applied to every plugin in the list. |
| `commit` | no | Integration sha, 7 to 40 hex characters. Becomes the commit link in the changelog. |
| `hold` | no | `true` keeps this fragment out of normal windows and survives the cut. Default `false`. |
| `category` | no | Board category, carried for context. |
| `story` | no | Board story id, carried for context. |
| `body` | n/a | Everything after the closing `---`. Optional. |

Anything else is rejected, so a typo like `plugin:` fails loudly instead of silently releasing
nothing.

### Per-plugin bump levels

When one ticket means different things to different plugins, use the map form:

```yaml
plugins:
  sidequest: minor
  workbench: patch
```

A `bump` value is still allowed alongside it and acts as the default for any entry left empty.

### Choosing a level

Same criteria the repo has always used, now written down once:

- `patch`: docs, comment fixes, small bug fixes.
- `minor`: new behavior, a new flag, a new failure mode handled.
- `major`: a breaking change to how the plugin is invoked or configured.

A window takes the highest level any fragment asks for per plugin, so thirteen patch fragments
for one plugin produce one patch bump, not thirteen.

### Plugins that are not published

Only plugins listed in `.claude-plugin/marketplace.json` can appear in a fragment. Something like
`plugins/test-support` has no version and no users, so it never needs one.

## Holding a release

Two switches, either one stops publication:

- `hold: true` in a fragment holds that one change. The rest of the window still ships.
- A `.release/HOLD` file holds the whole window. Its contents are the reason, printed by the cut.
  A hotfix still runs during a HOLD, because an urgent fix has to be able to ship.
