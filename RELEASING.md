# Releasing

v2 is public since 25 November 2026. It lives on the `v2` branch of `Eigenwise/eigenwise-toolshed`, under the marketplace name `toolshed-next`. `main` in that repository is v1 (`eigenwise-toolshed`), deprecated and frozen. v2 does not take over `main`: every v1 install follows that branch.

Work happens on short branches in a working checkout and is checked there. A release puts the finished tree on `v2` as one commit.

## Where the version lives

In `plugins/<name>/.claude-plugin/plugin.json`, and nowhere else. The marketplace file carries no version, and `tests/structure.test.mjs` fails if one appears. Claude Code keeps users on their cached copy until that version string changes, so a change that should reach people needs a bump.

## What a release is

A release is a commit on `v2` that bumps the version in `plugin.json`. Its message is the changelog: what changed for someone using the plugin, in plain words. There are no fragment files, no changelog file to edit, no release branch, no sync-back branch and no second run of CI.

Bump by hand. Patch for a fix, minor for something new, major when a user has to change something they did.

## Publishing

The finished tree goes onto `v2` as one commit, with none of the working history. `research/`, `.sidequest/` and `OVERVIEW.md` stay out of that commit: they are working notes, this project's own board and its status page. Before the push, a search of what is left for private names and paths has to print nothing.

## Tags

After a release, tag each bumped plugin from a clean checkout of `v2`:

```bash
claude plugin tag plugins/<name> --push
```

The command checks that `plugin.json` and the marketplace entry agree, then creates the `<name>--v<version>` tag. Use `--dry-run` first if unsure.

## Dogfooding needs no release

A marketplace added from a local folder loads plugins in place. Add this checkout as a marketplace, enable the plugin, edit a file, reload plugins in the session. The edit is live. Cut a release only when other people should get the change.

## Before a release

```bash
node scripts/check.mjs
```

It validates and tests every plugin, runs the repository tests, checks that shared files are in sync, and prints the budget table. CI repeats the node tests and the sync check and runs this check with Claude Code pinned to `CLAUDE_CODE_VERSION` in `check.yml`. A push runs Linux only, and a newer push cancels the run of an older one. Windows runs when asked for, once per batch and before a release, with `gh workflow run check.yml`. On a Windows machine `node scripts/check-as-the-runner.mjs` runs the same check under the Windows runner's two conditions that a local run misses (the temp folder reached through another spelling than git answers with, and git converting line endings), so it can be repeated with or without CI. Until its CI run has finished a batch is "checked locally, not confirmed on CI". Types are measured only where `.types/claude-code.d.ts` exists (copy it from the `types/` folder of Claude Code's plugin-authoring skill, and a linked worktree takes the main checkout's copy by itself); without it the check says `types not measured` and still passes, so CI never measures types. A separate `host canary` workflow runs it on the newest Claude Code and is never a required check: when it goes red, fix the mod, then raise the pin.

The check also waits for a `clean-room` job. `node scripts/clean-room.mjs [source]` installs every plugin from the marketplace into an empty Claude config, then runs `claude plugin validate` and `claude plugin test` on the installed copies. CI points it at the checkout on every event, because that is the code under test. Pass `Eigenwise/eigenwise-toolshed#v2` as the source to try what a user gets.

## The cutover from v1

- **v2 ships under its own marketplace name, `toolshed-next`.** It does not take over `eigenwise-toolshed`. That marketplace auto-updates and is enabled through committed settings in team repositories, so taking its name would put v2 in front of a team on their next update without the team deciding, and before any project's rules, map, gateway wiring or tickets were handled. Its gateway has no v2 counterpart and would vanish under projects still pointed at it.
- **v1 is frozen, with a pointer.** Its README, its `update-toolshed` skill and one line in its board's session-start text say that v1 is deprecated and where v2 lives. Updating v1 does not get anyone v2.
- **No board converter.** The v1 board stays a read-only archive until the home cleanup, and the upgrade offers per project to redraft the tickets the person picks.
- Each project moves once, with `quartermaster:upgrade` ([UPGRADING.md](UPGRADING.md)).
