# Upgrading from the older Toolshed

The older Toolshed is the `eigenwise-toolshed` marketplace, on `main` of Eigenwise/eigenwise-toolshed. It's deprecated as of 25 November 2026: no more fixes, no new releases, and updating it does not get you v2. v2 is the `v2` branch of the same repository, under its own name, `toolshed-next`: `claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2`. The move is per project, done by an agent with you in a few minutes of your time, and the shared state in your home folder is cleaned once, after the last project.

## Which projects still have it

One read of the install record, nothing written. It works in bash and in PowerShell, Windows PowerShell 5.1 included (the strings are in backticks because 5.1 drops double quotes on the way to `node`):

```bash
node -e 'const path=require(`path`);const record=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(require(`os`).homedir(),`.claude`),`plugins`,`installed_plugins.json`);for(const[id,entries]of Object.entries(require(record).plugins))if(id.endsWith(`@eigenwise-toolshed`))for(const entry of entries)console.log(entry.scope,entry.projectPath||`(user)`,id.split(`@`)[0])'
```

Each line is a scope, a project folder and an older plugin installed there. Installed is not the same as on: the scan below says which ones are still on.

## Moving a project

The page is the Quartermaster skill `upgrade`, at [plugins/quartermaster/skills/upgrade/SKILL.md](plugins/quartermaster/skills/upgrade/SKILL.md). An agent reads it and follows it from the top: it scans, says what it found, asks you at most three things in one message, takes the reversible steps itself and tells you how to undo each. Nothing leaves your machine: it never pushes, never creates a repository and never opens a pull request. It's done when the scan says the project moved, with whatever is kept on purpose listed beside its reason.

With v2's Quartermaster installed (the [README](README.md#install) has the two commands; in a project that has the older one on, add `--scope local`), reload plugins and run `/quartermaster:upgrade` in the project. Without it, an agent can read the page above and follow it as it is: its first step installs Quartermaster, then scans.
