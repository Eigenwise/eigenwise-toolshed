# The home folder

The older version kept state under the home folder that every project shares: one board database for all projects, its backups, a worktree folder per project, a worktree quarantine, dispatch records, briefings, sweep reports, hook state, generated agents. Measured on one machine it held 68 GB, and counting that took over an hour. It is the biggest win of the upgrade and its most dangerous step: some of those worktrees may hold work that exists nowhere else.

## Its own run, never part of a project's

- A project's run never shows, sizes or removes anything under the home folder. The scan prints the home groups so you know they are there; leave them.
- The home cleanup is its own run, once, and only when the scan's home line says no project has a plugin of the older version switched on or installed.
- Everything of `eigenwise-toolshed` that this version also uses stays, whatever group a listing puts near it: its plugin cache, its known-marketplaces record, and the data folder of every plugin this version has (the update kept it, so it is this version's). Never run `claude plugin marketplace remove eigenwise-toolshed`: that is this version's own marketplace.
- Each group gets its own yes. A yes the person gave for a project's things is not a yes for anything under the home folder, and a yes for one group is not a yes for another.

The gateway question is the exception: it is asked once, before the first project moves, because unwiring has to happen in each wired place before the gateway is uninstalled.

## Questions

**2**, and 3 only when a telemetry collector listens on the endpoint in the user settings:

- **The gateway**: keep it for models from other providers in the main session's picker (say plainly that it can no longer be updated or installed again from this marketplace), or stop it. Recommend stopping it unless they use such models.
- **Which groups go**: one message, one yes or no per group, after you showed the listing. Recommended: yes to `records`, `other-plugins` and `worktree-folders`; `ticket-evidence` is where the space is and holds no work, so yes once they no longer want the old board's history; `quarantine` only after they looked at what it holds; `board-database` kept as a read-only archive unless they want the space back.

## The steps, in order

| # | Do | What it means | Undo |
| --- | --- | --- | --- |
| 1 | Run the scan with `--all-projects`. Its list must show no project with a plugin of the older version switched on or installed, except a project whose only one is the gateway with a keep answer recorded in that project. An older version still installed is updated first, with the scan's Update first commands. The two plugins only the older version had, on in the `(user)` row, are on for every project: `claude plugin uninstall <name>@eigenwise-toolshed --scope user` takes each out everywhere, the gateway only once no place is wired to it; the scan's home line and the quiet step's listing name them, and neither writes the user settings file. The list is most recently used first, each row with the date of its last session or commit. Projects used in the last 30 days get the guided run when someone works there. For the rest, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-quiet-projects.mjs"`, which only lists them with the plugins it would switch off, show that list, and on one yes for it run the same command with `--switch-off`, then the scan again. It switches off only `quality-gate`, never the gateway and never a plugin this version has (`observability` among them), and a project whose only plugin on is the gateway still counts here until it is unwired and uninstalled. | Nothing still depends on what goes next. | The quiet step copied each local settings file first (`settings.local.json.before-upgrade`, or a dated name when that one was already there) and printed each copy's name. Copy it back over the file. |
| 2 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-home.mjs"`. It only reads. | It checks every project's worktree folders against that project's repository with Sidequest's worktree verdicts, then sizes each group it offers with a 5 second allowance. A group that runs out reads `at least 12 GB, still more`; `--exact-sizes` waits for the full count, `--size-seconds <n>` sets the allowance. It names eight keeps per list and counts the rest; `--all-keeps` names every one. It prints a line per group as each check or count starts and ends: pass those lines on to the person as they come, so nobody watches a silent minute. | |
| 3 | Show the listing as it is and ask the groups question. | Each group: its count, its size, what removing it loses, and for the worktrees every keep with its reason and the agent branch count. | |
| 4 | Gateway dropped: once no place is wired to it and every project's run uninstalled it, stop it with its own `stop`, then remove `model-gateway/`. Kept: leave it alone. | Its wiring runs a launcher in `model-gateway/` that finds the gateway through its install: removed while a place is still wired, every prompt there is blocked. | None from this marketplace, which no longer lists it. |
| 5 | Telemetry keys in the user settings (`settings.json` in the config folder): copy the file to `settings.json.before-upgrade`, then delete the keys, unless something listens on that endpoint. Only a local endpoint reads remove; one pointing anywhere else is not the older Toolshed's, reads keep and stays. | This version's telemetry does not use them. | The copy. |
| 6 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-home.mjs" --remove <groups>`, naming only the groups the person said yes to, comma separated. Report what it prints: what was removed, what was kept and why, what came back. | It removes entry by entry inside each group, never a parent folder, so the worktree root never goes along with the board folder. An entry it cannot remove whole is not given up: it goes in and removes what it can, child by child, and what cannot be read or removed stays and is named with its reason (eight named, the rest counted). Everything beside it goes. The report says `nothing removed from <group>`, `removed part of <group>: 34 of 35 items` or `removed <group>`, and gives the space back only for a group that went whole; for a part it says the space was not measured, so never quote the size from the listing as freed. A symbolic link or junction inside an entry is removed as a link and what it points at is never touched or walked into. The worktree group goes through the verdicts again and removes only the safe folders and the agent branches `git branch -d` accepts. It refuses while any project still has the older version on or installed. | None. That is why it waited for the yes. |
| 7 | Nothing for the marketplace. | `eigenwise-toolshed` is this version's own marketplace now: its record, its cache and its clone stay. | |

Without this version's Sidequest installed (under either name), step 2 says so and offers no worktree folder at all. The same when the installed copy is too old or its script fails: every worktree folder is kept with that reason, the run says once why, and the other groups list as usual. Update Sidequest and run step 2 again, or leave the worktree group for later. `--worktrees-script <path>` names the worktree script to use instead of the installed one, for a run against a checkout.

## The groups

Each lives under the config folder (`~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise). The listing names the ones it finds.

| Group | What it holds | What removing it loses |
| --- | --- | --- |
| `board-database` | `sidequest/sidequest.db` with its `-wal` and `-shm` files, a copy taken before a migration, `backups/`, `backup-<date>/` | every project's old tickets, stories and routes. Keeping it as a read-only archive is the alternative |
| `worktree-folders` | `sidequest/worktrees/<project>/<worktree>`, plus the leftover `worktree-agent-*` branches in each project's repository | only what the verdicts call safe: a folder whose every file the repository already holds, a branch already merged. A folder whose repository is gone, one with uncommitted files or files no commit holds, one with links, and an unmerged branch are kept and named |
| `quarantine` | `sidequest/worktree-quarantine/`, `sidequest/worktree-backups/` | copies of agent work the older sweep set aside instead of deleting. Some may hold work found nowhere else |
| `ticket-evidence` | `sidequest/projects/<project>/`: what old tickets attached, their verification output, captures and integration data | the old board's record of what each ticket attached and how it was checked. On a real machine this was 58 of 68 GB. No work lives here, so it is a different yes from a worktree |
| `records` | everything else in `sidequest/`: `dispatch/`, `dispatch-tokens/`, `briefings/`, `sweep-reports/`, `hook-state/`, `compaction-*`, `tmp/`, sweep files, the launcher | history only. Nothing in this version reads it |
| `other-plugins` | `codebase-mapper-state/`, `live-rules-state/`, `quartermaster-state/`, `eigenwise-toolshed/`, `toolshed/registry/`, `codex-gateway/`, `agents/sidequest-exec*`, `agents-backup-sidequest-*`, and the data folders of the two plugins only the older version had (`plugins/data/quality-gate-eigenwise-toolshed`, `model-gateway-…`) | nothing this version reads. The listing names each generated agent file (eight, then a count); an agent file written by hand that merely starts with `sidequest-` is not in the group. Not `quartermaster/events/` or `toolshed/` itself, and never the data folder of a plugin this version has |

Not in any group:

| Entry | Verdict | Why |
| --- | --- | --- |
| `model-gateway/` | ask | the gateway itself, per the gateway answer |
| `plugins/cache/eigenwise-toolshed/` | keep | this version's own cache: the host manages it |
| `plugins/known_marketplaces.json` | keep | this version's own marketplace record |
| an `eigenwise-toolshed` folder in the system temp folder | remove | freshness warnings. The scan does not look there; check by hand |
| `observability/ledger/` | keep | the person's usage history, which this version's observability reads and keeps writing; nothing here removes it |
| `settings.json.bak-*` | keep | the person's own undo, not the older version's state |
