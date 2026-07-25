# Release engine

Four scripts, no dependencies, deterministic from the tree. They turn the queue in
`.release/unreleased/` into one release commit, one set of tags, and generated changelogs.
Node 22, `.mjs`, standard library only, so a CI runner needs nothing installed.

| Script | Writes | What it does |
| --- | --- | --- |
| `note.mjs` | one fragment | Records what a ticket releases, at integration time |
| `plan.mjs` | nothing | Prints exactly what a cut would do |
| `cut.mjs` | the release | Builds the window locally, publishes it in one atomic push |
| `guard.mjs` | nothing | Fails CI when the tree breaks a release invariant |

See `.release/README.md` for the fragment schema.

## The shape of a window

Integration puts verified work on `dev` and writes a fragment. Nothing is published: no version
moves, no tag, no docs deploy, and the marketplace clone only follows `main`, so an installed copy
physically cannot see it.

A cut merges `dev` into `main`, bumps only the plugins named by fragments, generates the
changelogs, deletes the consumed fragments, commits once, tags, runs the changed plugins' suites,
and pushes everything with a single `git push --atomic`.

## Determinism

Every input comes from the tree at a pinned sha: which fragments exist, which plugins they name,
the current versions, and the release date (the pinned commit's own date). `plan.mjs` and
`cut.mjs` call the same `buildPlan`, so a plan cannot disagree with the cut it describes.

Two runs against the same tree produce the same answer. A rerun after a successful cut finds its
fragments consumed and its refs already in `CHANGELOG.md`, so it releases nothing rather than
publishing the same window twice.

## Atomicity

`cut.mjs` builds the entire release before it touches a remote: merge, versions, changelogs,
commit, tags, suites. All of that is local and disposable. The only command that changes a remote
is the final

```
git push --atomic origin HEAD:main v3.208.0 sidequest-v3.7.0 ...
```

Every ref moves or none do, which rules out both bad half-states: `main` published without its
tag (a release commit that never creates a Release) and tags pushed without `main` (a tag pointing
at a commit that is not on the branch).

Any failure before that push leaves the remote untouched, the fragments still queued, and the
next window free to retry. `cut.mjs` prints the push command by default and only runs it with
`--push`.

## Usage

```bash
# At integration time, in the same push as the ticket's code
node scripts/release/note.mjs SQ-843 --title "..." --plugins sidequest --bump minor --commit "$(git rev-parse HEAD)"

# Any time, from anywhere: what would ship?
node scripts/release/plan.mjs
node scripts/release/plan.mjs --json

# Build a window without publishing it
node scripts/release/cut.mjs --sha origin/dev --dry-run
node scripts/release/cut.mjs --sha origin/dev              # builds locally, prints the push
node scripts/release/cut.mjs --sha origin/dev --push       # builds and publishes

# Urgent fix, only these tickets, cut from main
node scripts/release/cut.mjs --mode hotfix --tickets SQ-843,SQ-845 --push

# CI
node scripts/release/guard.mjs --mode dev --publish-ref origin/main --changed-file changed.txt
node scripts/release/guard.mjs --mode main --publish-ref origin/main@{1} --changed-file changed.txt
```

`--help` on any of them prints the full option list.

## Two rules worth knowing before you wire anything to this

A hotfix patches the **marketplace counter**, not the plugin. Each plugin still moves by whatever
level its own fragment declared, because the fragment is the only thing that knows whether the fix
was a one-line patch or a new failure mode. Forcing every hotfixed plugin to a patch would publish
a version number that lies about what changed.

Nothing releases twice. A cut deletes the fragments it consumed, and `CHANGELOG.md` is the ledger:
`plan.mjs`, `cut.mjs`, and `guard.mjs` all skip a ref that already has an entry. That is what keeps
a hotfix, whose fragment lives on `dev` where the cut cannot delete it, from shipping again in the
next normal window.

## Tests

```bash
node --test scripts/release/test/*.test.mjs
```

The git-touching tests run against a recorder, not a repository, so the suite never contacts
GitHub and never moves a ref. `atomic.test.mjs` asserts that directly: no command that can change
a remote runs before the single `push --atomic`, and a suite failure leaves zero of them.
