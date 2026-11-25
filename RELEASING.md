# Releasing

The Toolshed lives on `main` of `Eigenwise/eigenwise-toolshed`, under the marketplace name `eigenwise-toolshed`. The older version lives on the `v1` branch and is not maintained. The `v2` branch gets no more commits and is kept so links to it still answer.

Work happens on short branches in a private working checkout and is checked there. A release is a pull request to `main` that bumps a version: its branch holds the published tree as one commit on top of `main`.

## Where the version lives

In `plugins/<name>/.claude-plugin/plugin.json`, and nowhere else. The marketplace file carries no version, and `tests/structure.test.mjs` fails if one appears. Claude Code keeps users on their cached copy until that version string changes, so a change that should reach people needs a bump.

The first versions of this line are sidequest 7.0.0, quartermaster 2.0.0, codebase-mapper 3.0.0, live-rules 3.0.0 and observability 2.0.0. The upgrade tells the older version from this one by those majors, so a plugin never goes back below its first one.

People are told one name for all five: Toolshed 2. It goes on the release entry, in the docs and on one tag of its own, `toolshed--v2.0.0`. The plugin numbers stay each plugin's own and continue from the older version's (its sidequest was at 6, so this one starts at 7). The older version's own releases were tagged v3.x, and those tags stay.

## What a release is

A pull request to `main` that bumps the version in `plugin.json`. Its message is the changelog: what changed for someone using the plugin, in plain words. There are no fragment files, no changelog file to edit, no release branch, no sync-back branch and no second run of CI.

Bump by hand. Patch for a fix, minor for something new, major when a user has to change something they did.

`research/`, `.sidequest/` and `OVERVIEW.md` are working notes, this project's own board and its status page, and they stay in the private working repository. The published tree is built from the working tree without those three, and the pull request carries that tree. A search of that tree for private names and paths runs before the pull request is opened and has to print nothing. No script builds the tree yet: it is made by hand, so check the three are absent before searching.

## The cutover from the older version

This is how the older Toolshed on `main` becomes this one. It runs once, in this order. Step 4 is the one that cannot be taken back cleanly: installs without a pin take it at their next update, without deciding.

1. Create the branch `v1` at the tip of `main`.
2. Known team repositories that enable an older plugin in their committed settings have moved or pinned.
3. The owner changes the required checks on `main` to `check-complete`.
4. The takeover pull request to `main`: this version's tree as one commit on top of the older history. The docs site deploys from `main` with it (`.github/workflows/docs.yml`, Pages set to deploy from GitHub Actions), so the older docs are replaced at the same address. From here an install that follows `main` gets this version at its next update.
5. One commit on `v1` for its README and its marketplace description.
6. The same published tree goes onto `v2` as a child commit, and `v2` is frozen. It is kept so its links answer.
7. The five plugin tags and `toolshed--v2.0.0`, then the release entry: a GitHub release titled Toolshed 2 on that tag.
8. Words to other people.

The cost is the update itself. An older install takes this version without deciding, and this version does not read the older board, rules or map. That is why the product says once, in each project, what is no longer used and which command moves it (`/quartermaster:upgrade`, [UPGRADING.md](UPGRADING.md)). `model-gateway` is not in this version's marketplace, so a project still wired to it needs it installed and switched on until the upgrade has unwired it: removed first, every prompt in that project is blocked. It can no longer be updated or installed again from this marketplace. There is no board converter: the older board stays a read-only archive, and the upgrade offers per project to redraft the tickets the person picks. `observability` updates in place: a project that was recording keeps recording, and its history stays.

Whoever needs the older version a while longer pins it: remove the marketplace, add it again as `Eigenwise/eigenwise-toolshed#v1`, and install again. It gets no fixes and no releases.

## Tags

After a release, tag each bumped plugin from a clean checkout of `main`:

```bash
claude plugin tag plugins/<name> --push
```

The command checks that `plugin.json` and the marketplace entry agree, then creates the `<name>--v<version>` tag. Use `--dry-run` first if unsure.

The cutover tags all five: `sidequest--v7.0.0`, `quartermaster--v2.0.0`, `codebase-mapper--v3.0.0`, `live-rules--v3.0.0` and `observability--v2.0.0`. The release entry sits on a sixth tag, `toolshed--v2.0.0`, made by hand on the same commit, from the same clean checkout of `main`: `git tag toolshed--v2.0.0`, then `git push origin toolshed--v2.0.0`. `claude plugin tag` only makes a plugin's tag.

## Dogfooding needs no release

A marketplace added from a local folder loads plugins in place. Add this checkout as a marketplace, enable the plugin, edit a file, reload plugins in the session. The edit is live. Cut a release only when other people should get the change.

## Before a release

```bash
node scripts/check.mjs
```

It validates and tests every plugin, runs the repository tests, checks that shared files are in sync, and prints the budget table. CI repeats the node tests and the sync check and runs this check with Claude Code pinned to `CLAUDE_CODE_VERSION` in `check.yml`. A push runs Linux only, and a newer push cancels the run of an older one. Windows runs when asked for, once per batch and before a release, with `gh workflow run check.yml`. On a Windows machine `node scripts/check-as-the-runner.mjs` runs the same check under the Windows runner's two conditions that a local run misses (the temp folder reached through another spelling than git answers with, and git converting line endings), so it can be repeated with or without CI. Until its CI run has finished a batch is "checked locally, not confirmed on CI". Types are measured only where `.types/claude-code.d.ts` exists (copy it from the `types/` folder of Claude Code's plugin-authoring skill, and a linked worktree takes the main checkout's copy by itself); without it the check says `types not measured` and still passes, so CI never measures types. A separate `host canary` workflow runs it on the newest Claude Code and is never a required check: when it goes red, fix the mod, then raise the pin.

The check also waits for a `clean-room` job, and `check-complete` is the one required check on `main`. `node scripts/clean-room.mjs [source]` installs every plugin of this tree from the marketplace into an empty Claude config, then runs `claude plugin validate` and `claude plugin test` on the installed copies. CI points it at the checkout on every event, because that is the code under test. Pass `Eigenwise/eigenwise-toolshed` as the source to try what a user gets.
