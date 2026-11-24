# The home folder

The older version kept state under the home folder that every project shares: one board database for all projects, its backups, a worktree folder per project, a worktree quarantine, dispatch records, briefings, sweep reports, hook state, generated agents. Measured on one machine it held 68 GB, and counting that took over an hour. It is the biggest win of the upgrade and its most dangerous step: some of those worktrees may hold work that exists nowhere else.

## Its own run, never part of a project's

- A project's run never shows, sizes or removes anything under the home folder. The scan prints the home groups so you know they are there; leave them.
- The home cleanup is its own run, once, and only when the scan's home line says no project has a plugin of the older version switched on in its settings.
- Each group gets its own yes. A yes the person gave for a project's things is not a yes for anything under the home folder, and a yes for one group is not a yes for another.

The gateway question is the exception: it is asked once, before the first project moves, because unwiring has to happen in each project before the gateway goes off.

## Questions

**2**, and 3 only when a telemetry collector listens on the endpoint in the user settings:

- **The gateway**: keep it for models from other providers in the main session's picker, or stop it. Recommend stopping it unless they use such models.
- **Which groups go**: one message, one yes or no per group, after you showed the listing. Recommended: yes to `records`, `other-plugins` and `worktree-folders`; `ticket-evidence` is where the space is and holds no work, so yes once they no longer want the old board's history; `quarantine` only after they looked at what it holds; `board-database` kept as a read-only archive unless they want the space back.

## The steps, in order

| # | Do | What it means | Undo |
| --- | --- | --- | --- |
| 1 | Run the scan with `--all-projects`. Its list must show no project with a plugin of the older version switched on in its settings, except a project whose only ones are the gateway with a keep answer recorded in that project, or a mapper or rules plugin the scan keeps on because git tracks what only it loads there. Older plugins on in the `(user)` row are on for every project: `claude plugin disable <name>@eigenwise-toolshed --scope user` switches each off everywhere, once no project needs it; the scan's home line and the quiet step's listing name them, and neither writes the user settings file. The count is of settings keys, not of live projects: the list is most recently used first, each row with the date of its last session or commit, whichever is newer. Projects used in the last 30 days (a session or a commit) get the guided run when someone works there. For the rest, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-quiet-projects.mjs"`, which only lists them with the plugins it would switch off, show that list, and on one yes for it run the same command with `--switch-off`, then the scan again. With the gateway dropped, every project was unwired in its own run; the quiet step leaves the gateway plugin and its wiring alone, never switches off a mapper or rules plugin that holds what git tracks, and a project whose only plugin on is the gateway plugin still counts here until then. | Nothing still depends on what goes next. | The quiet step copied each local settings file first (`settings.local.json.before-upgrade`, or a dated name when that one was already there) and printed each copy's name. Copy it back over the file. |
| 2 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-home.mjs"`. It only reads. | It checks every project's worktree folders against that project's repository with Sidequest's worktree verdicts, then sizes each group it offers with a 5 second allowance. A group that runs out reads `at least 12 GB, still more`; `--exact-sizes` waits for the full count, `--size-seconds <n>` sets the allowance. It names eight keeps per list and counts the rest; `--all-keeps` names every one. It prints a line per group as each check or count starts and ends: pass those lines on to the person as they come, so nobody watches a silent minute. | |
| 3 | Show the listing as it is and ask the groups question. | Each group: its count, its size, what removing it loses, and for the worktrees every keep with its reason and the agent branch count. | |
| 4 | Gateway dropped: stop it with its own `stop`, then remove `model-gateway/` on the gateway answer. Kept: leave it alone. | | The gateway's own setup. |
| 5 | Telemetry keys in the user settings (`settings.json` in the config folder): copy the file to `settings.json.before-upgrade`, then delete the keys, unless something listens on that endpoint. Only a local endpoint reads remove; one pointing anywhere else is not the older Toolshed's, reads keep and stays. | v2 telemetry does not use them. | The copy. |
| 6 | `node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-home.mjs" --remove <groups>`, naming only the groups the person said yes to, comma separated. Report what it prints: what was removed, what was kept and why, what came back. | It removes entry by entry inside each group, never a parent folder, so the worktree root never goes along with the board folder. An entry it cannot remove whole is not given up: it goes in and removes what it can, child by child, and what cannot be read or removed stays and is named with its reason (eight named, the rest counted). Everything beside it goes. The report says `nothing removed from <group>`, `removed part of <group>: 34 of 35 items` or `removed <group>`, and gives the space back only for a group that went whole; for a part it says the space was not measured, so never quote the size from the listing as freed. A symbolic link or junction inside an entry is removed as a link and what it points at is never touched or walked into. The worktree group goes through the verdicts again and removes only the safe folders and the agent branches `git branch -d` accepts. It refuses while any project still has the older version on. | None. That is why it waited for the yes. |
| 7 | Only on the yes to `other-plugins`, last, and only when the scan lists the marketplace record with verdict remove. While a project still runs one of its plugins on purpose (a kept gateway, a mapper or rules plugin that holds what git tracks) the scan keeps the record, because removing the marketplace deletes those plugins: leave it and say so. Otherwise: `claude plugin marketplace remove eigenwise-toolshed`, run from the config folder. Never from inside a repository: there it rewrote that repository's committed settings, taking out the older plugin keys and the marketplace declaration. Say in that yes that it deletes the older plugins' data. | No project names it any more. | `claude plugin marketplace add Eigenwise/eigenwise-toolshed` (no branch: the older version is `main`). The deleted plugin data does not come back. |

Without Sidequest from `toolshed-next` installed, step 2 says so and offers no worktree folder at all. The same when the installed copy is too old or its script fails: every worktree folder is kept with that reason, the run says once why, and the other groups list as usual. Update Sidequest and run step 2 again, or leave the worktree group for later. `--worktrees-script <path>` names the worktree script to use instead of the installed one, for a run against a checkout.

## The groups

Each lives under the config folder (`~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise). The listing names the ones it finds.

| Group | What it holds | What removing it loses |
| --- | --- | --- |
| `board-database` | `sidequest/sidequest.db` with its `-wal` and `-shm` files, a copy taken before a migration, `backups/`, `backup-<date>/` | every project's old tickets, stories and routes. Keeping it as a read-only archive is the alternative |
| `worktree-folders` | `sidequest/worktrees/<project>/<worktree>`, plus the leftover `worktree-agent-*` branches in each project's repository | only what the verdicts call safe: a folder whose every file the repository already holds, a branch already merged. A folder whose repository is gone, one with uncommitted files or files no commit holds, one with links, and an unmerged branch are kept and named |
| `quarantine` | `sidequest/worktree-quarantine/`, `sidequest/worktree-backups/` | copies of agent work the older sweep set aside instead of deleting. Some may hold work found nowhere else |
| `ticket-evidence` | `sidequest/projects/<project>/`: what old tickets attached, their verification output, captures and integration data | the old board's record of what each ticket attached and how it was checked. On a real machine this was 58 of 68 GB. No work lives here, so it is a different yes from a worktree |
| `records` | everything else in `sidequest/`: `dispatch/`, `dispatch-tokens/`, `briefings/`, `sweep-reports/`, `hook-state/`, `compaction-*`, `tmp/`, sweep files, the launcher | history only. Nothing in v2 reads it |
| `other-plugins` | `codebase-mapper-state/`, `live-rules-state/`, `quartermaster-state/`, `eigenwise-toolshed/`, `toolshed/registry/`, `codex-gateway/`, `agents/sidequest-exec*`, `agents-backup-sidequest-*`, `plugins/data/*-eigenwise-toolshed` | nothing v2 reads. The listing names each generated agent file (eight, then a count); an agent file written by hand that merely starts with `sidequest-` is not in the group. Not `quartermaster/events/` or `toolshed/` itself, which are v2's. While a project's tracked map or rules still need the older mapper or rules plugin, that plugin's own state (`codebase-mapper-state/` or `live-rules-state/`, and its plugin data) is left out of the group and listed as kept |

Not in any group:

| Entry | Verdict | Why |
| --- | --- | --- |
| `model-gateway/` | ask | the gateway itself, per the gateway answer |
| `plugins/cache/eigenwise-toolshed/` | keep | the host manages its cache |
| an `eigenwise-toolshed` folder in the system temp folder | remove | freshness warnings. The scan does not look there; check by hand |
| `observability/ledger/` | keep | the person's usage history; nothing in v2 reads it and nothing here removes it |
| `settings.json.bak-*` | keep | the person's own undo, not the older version's state |
