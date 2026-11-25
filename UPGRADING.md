# Upgrading from v1

A normal plugin update replaces v1's `sidequest`, `quartermaster`, `codebase-mapper`, `live-rules` and `observability` with this version under the same names: `claude plugin marketplace update eigenwise-toolshed`, then `claude plugin update <plugin>@eigenwise-toolshed --scope <its scope>` for each. That changes nothing in your projects, and this version does not read what v1 left there (its board, rules and map). Moving a project takes a few minutes with an agent: run `/quartermaster:upgrade` in it.

`observability` updates in place: a project that was recording keeps recording, and its history stays.

`quality-gate` and `model-gateway` are not in this version. They show as "not found in marketplace" until you uninstall them. Uninstall `model-gateway` only after every project wired to it is unwired, which the upgrade does: removing it first blocks every prompt in a wired project.

v1 lives on the `v1` branch and is not maintained. To stay on it, remove the marketplace, add it again as `Eigenwise/eigenwise-toolshed#v1`, and install your plugins again.

## What is still the older version

One read of the install record, nothing written. It works in bash and in PowerShell, Windows PowerShell 5.1 included (the strings are in backticks because 5.1 drops double quotes on the way to `node`):

```bash
node -e 'const path=require(`path`);const record=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(require(`os`).homedir(),`.claude`),`plugins`,`installed_plugins.json`);const first={sidequest:7,quartermaster:2,[`codebase-mapper`]:3,[`live-rules`]:3,observability:2};for(const[id,entries]of Object.entries(require(record).plugins))for(const entry of entries){const[name,market]=id.split(`@`);const older=market===`eigenwise-toolshed`&&!(parseInt(entry.version)>=first[name]);if(older||market===`toolshed-next`)console.log(older?`older`:`earlier-name`,entry.scope,entry.projectPath||`(user)`,name,entry.version)}'
```

Each line is a plugin that still needs something, with its scope, its project folder and its version. `older` is the older version: below sidequest 7, quartermaster 2, codebase-mapper 3, live-rules 3 or observability 2, or one of the two plugins this version doesn't have. Update the first five as above; the upgrade takes out the other two, the gateway only after it's unwired everywhere. `earlier-name` is this version installed as `toolshed-next`, its name before it took over `eigenwise-toolshed`. It keeps working, and the upgrade moves it when you say so. No lines means every install is this version.

## A team repository that committed the older mapper and map

When the repository's committed settings enable `codebase-mapper@eigenwise-toolshed` and git tracks `.claude/.codebase-info/`, the map is the team's, so it moves for everyone in one pull request:

- The map converted to this version's rule files, `.claude/rules/codebase-map.md` and one card per area under `.claude/rules/map/` (`/codebase-mapper:map` does it from the old folder).
- The mapper out of the committed settings, or the team's stated choice to keep it so someone can run `/codebase-mapper:refresh`. The key needs no other edit: after the update it is this version's mapper.
- The older `.claude/.codebase-info/` folder removed.

The converted map is plain rule files. Claude Code loads them with the plugin off or never installed, so a teammate who installs nothing still gets the map once the pull request merges. Until it merges, a teammate on this version has no map, because this version does not read the older folder. One person's own copy of the new map would drift from the team's.

## Moving a project

The page is the Quartermaster skill `upgrade`, at [plugins/quartermaster/skills/upgrade/SKILL.md](plugins/quartermaster/skills/upgrade/SKILL.md). An agent reads it and follows it from the top: it scans, says what it found, asks you at most a few things in one message, takes the reversible steps itself and tells you how to undo each. It never switches off or removes this version's own plugins or marketplace. Nothing leaves your machine: it never pushes, never creates a repository and never opens a pull request. It's done when the scan says the project moved, with whatever is kept on purpose listed beside its reason.

With Quartermaster installed (`claude plugin install quartermaster@eigenwise-toolshed --scope local` when it's missing), reload plugins and run `/quartermaster:upgrade` in the project. Without it, an agent can read the page above and follow it as it is: its first step installs Quartermaster, then scans.
