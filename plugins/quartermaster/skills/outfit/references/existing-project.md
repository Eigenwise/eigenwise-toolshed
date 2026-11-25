# A project that already has a team and tools

Most projects are not empty. Outfit changes as little as it can and never decides for teammates.

## Personal or for the team

A team project is one with other git authors or a committed `.claude/settings.json`.

- In a team project, install with `--scope local` until the human says the team adopts it. Local scope writes `.claude/settings.local.json`, which stays out of git, so nothing changes for anyone else.
- A project-scope install is a team decision. Say what will then run for every contributor. Declare the marketplace in the same change (`claude plugin marketplace add Eigenwise/eigenwise-toolshed --scope project`), or teammates get an enabled plugin they cannot resolve.
- In a solo project, project scope is fine.

## A plugin of the same name from another marketplace

`claude plugin list --json` shows the marketplace after the `@`. A plugin with our name from another marketplace (a fork, a copy) is a clash, never an install. Two are not: the older Toolshed, which shares our marketplace name `eigenwise-toolshed` and is told apart by its version, and `toolshed-next`, this version under its earlier name. Both have their own section below, and outfit leaves both to `upgrade`. For any other marketplace: both would load, their skills share one namespace, and the other one's hooks keep firing on our work.

- Say which plugins clash and at which scope each is enabled.
- Offer to disable the other one, one plugin at a time: `claude plugin disable <name>@<marketplace> --scope <scope>`.
- One enabled in the committed settings is the team's. Leave that file alone and disable it at local scope instead, which overrides it for this person only.
- If they keep the other one, skip our plugin of that name and say so. Never run both.

## The project is on the older version, or on the earlier name

When the exploration prints a line from `upgrade-scan.mjs --line`, say that line as it is, once, in what you found. It is no upgrade: outfit changes nothing about the older plugins or the earlier name, asks nothing about them and carries on with what it was asked. The `upgrade` skill updates or moves them, when the person wants that.

Never install a plugin of ours while an older version of it is installed here (the line says update first), or while it is installed as `<name>@toolshed-next`: both would load. Skip it, say so, and leave it to `upgrade`.

## A plugin of ours installed by hand

Each line from `found-installed.mjs` is a plugin of ours that is installed here with no change record, so the undo would miss it, except a line that says installed for all projects: that one is only listed, because its undo would remove it from every project. Say what was found in one line, then write the records:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/found-installed.mjs" --project "${CLAUDE_PROJECT_DIR}" --record
```

It writes a proposal that says the plugin was found already installed and gives the uninstall command, plus a change record that restores no file, and changes nothing else. Rolling that record back does not uninstall: run the command it names.

## What the team already has

- **A committed codebase map or rules from another tool**, referenced by the project's instructions: leave them. Offer ours only as a team decision, never on a personal trial.
- **Guidelines outfit writes down** in a team repository are the team's: write them in the working tree and show the diff for the team's own way of committing, never as one person's copy hidden through an exclude line.
- **Personal rules** in a folder that is ignored or excluded: anything migrated from it stays excluded too. Add the new paths to `.git/info/exclude`, or say plainly that they will be committed.
- **The project's own skills and rules** for starting an issue, naming branches, opening pull requests, updating a tracker or writing release notes: name them in what you found. Sidequest delivers through them and keeps their approval steps.

## What stays out of git

The board (`.sidequest/`) excludes itself through `.git/info/exclude` the first time it is written. Quartermaster's records (`.claude/quartermaster/`) carry their own `.gitignore` in that folder. A team can choose to commit the records later. The board stays personal: a team shares work through its tracker.
