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

## Delivery and notification

The marketplace manifests on `main` are delivery. Bump the affected marketplace and plugin versions
with every ticket that changes a plugin, and never hold a bump for a GitHub Release. Claude Code
caches plugins by version, so that manifest change is what users install.

A GitHub Release is notification-only. `.github/workflows/release-cut.yml` reads the marketplace
version from `main` once a day, does nothing when that version already has a Release, otherwise tags
that exact `main` commit and creates one GitHub Release with generated notes. It also has a manual
trigger. It never runs `cut.mjs`, changes a version, or pushes `main`; cuts stay local and human-run
under the publish lock.

Before any publication, acquire the Sidequest lock and keep it until the atomic push completes:

```bash
sidequest publish lock --by <who>
# run cut.mjs, review its plan and checks, then run its printed git push --atomic command
sidequest publish unlock --by <who>
```

The pre-push guard on `main` enforces the lock. If a cut fails before its final push, unlock after
recording the failure so another window can retry.

## The shape of a window

Integration puts verified work on `dev` and writes a fragment. Nothing is published: no version
moves, no tag, no docs deploy, and the marketplace clone only follows `main`, so an installed copy
physically cannot see it.

A cut merges `dev` into `main`, bumps only the plugins named by fragments, generates the
changelogs, deletes the consumed fragments, commits once, tags, runs the changed plugins' suites,
and pushes everything with a single `git push --atomic`.

## Determinism

Every input comes from one commit: the fragments, the manifests, the versions, the changelog
ledger, and the release date (the pinned commit's own date). `git show <pin>:<path>`, never the
checkout. A cut run from `main` with `--sha origin/dev` reads dev's tree, so `--dry-run` describes
the cut that follows it rather than a mixture of the two. `plan.mjs` and `cut.mjs` call the same
`buildPlan`, so a plan cannot disagree with the cut it describes.

A normal window also has to be reachable: the cut refuses unless the publish branch is already an
ancestor of the pin, since a window that could not fast-forward is not a window.

`plan.mjs` reads the working tree by default and says so in its output. Pass `--sha` when you want
the pinned answer.

Two runs against the same tree produce the same answer. A rerun after a successful cut finds its
fragments consumed and its refs already in `CHANGELOG.md`, so it releases nothing rather than
publishing the same window twice.

## Atomicity

`cut.mjs` builds the entire release before it touches a remote: merge, versions, changelogs,
commit, tags, suites. All of that is local and disposable. The only command that changes a remote
is the final

```
git push --atomic origin <release-sha>:refs/heads/main refs/tags/v3.208.0:refs/tags/v3.208.0 ...
```

Every ref moves or none do, which rules out both bad half-states: `main` published without its
tag (a release commit that never creates a Release) and tags pushed without `main` (a tag pointing
at a commit that is not on the branch).

The branch refspec names the verified commit, never `HEAD`. Suites run arbitrary repository code,
so between "the suites passed" and "publish", the engine re-checks that HEAD is still the release
commit, the index is empty, and every tag still points at it. Anything else aborts before the push.
Suites also run with credentials stripped from their environment (`GITHUB_TOKEN`, `NPM_TOKEN`,
`SSH_AUTH_SOCK` and friends) and with git's global and system config neutralised. That is a
reduction in reach, not a proof, which is why the ref check is the actual guarantee.

Any failure before that push leaves the remote untouched, the fragments still queued, and the
next window free to retry. `cut.mjs` prints the push command by default and only runs it with
`--push`. Before it prints that command, a GitHub remote must have a passing `Test` workflow for
the current remote publish-branch head. The local release parent has no CI run yet, so it is never
the check target. A failed or missing run stops the cut unless `--ci-override "<reason>"` records
why it may continue, such as a release that repairs CI. A missing run also prints an optional
Docker command for reproducing the Sidequest suite locally; Docker is not required.

## What the engine refuses

- A marketplace `source` that is not exactly `plugins/<name>`, and any read or write whose path
  reaches through a symlink. Manifest data decides which files get rewritten, so it is treated as
  untrusted input.
- A staged index, always, `--allow-dirty` included. A pre-staged file would ride into the release
  commit no matter which paths the engine adds, which breaks the "this commit is what was
  verified" boundary. `--allow-dirty` tolerates unstaged and untracked files only.
- A version on disk that is not the one the plan was built from.
- A fragment title containing a newline or a control character, and any generated changelog line
  that does not read back as its own ref.
- `--tickets` naming the same ref twice.

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

`atomic.test.mjs`, `cut.test.mjs`, and `real-git.test.mjs` run against throwaway repositories with
a real local bare `origin` on disk, so the refspec and atomicity claims are settled by git rather
than by a mock. Nothing in the suite contacts a network. Among other things they prove that a
rejected tag rejects the whole push and leaves every remote ref where it was, that a suite which
moves HEAD, retargets a tag, or stages a file stops the release before it is published, and that
the three real 2026-07-23/24/25 windows come out as 3 cuts and 10 plugin bumps.
