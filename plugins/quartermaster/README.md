# quartermaster

Quartermaster helps with the setup work that tends to get repeated. It looks at a project and at bounded summaries of recent Claude Code sessions, asks what would help, and proposes one change at a time. Setup, resupply, updates, and health checks are separate workflows, and every install, file edit, or settings change waits for your approval.

It can set up a new or existing workspace, keep active Toolshed installs current, check their health, and suggest a missing skill, rule, measurement, permission, or plugin after real work has accumulated. A later pass checks whether an accepted change helped. Unused or ineffective changes can be rolled back.

When setup wires Model Gateway or Sidequest routing, it can also offer the optional `325000` `autoCompactWindow` setting for a consistent Codex compaction point. This is a consistency choice, not a prerequisite. Setup asks before writing it, and an existing user or project value is reported and preserved.

## Install

Quartermaster works at user, project, or local scope. Install it at the scope you want, for example:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quartermaster@eigenwise-toolshed --scope project
```

Project scope is the recommended starting point when the setup belongs to one repository. User scope makes its skills available in every project. Local scope keeps the install out of shared settings.

After installing, run `/reload-plugins` or start a new Claude Code session. Then use `/quartermaster:setup` in a project, or `/quartermaster:resupply` after some real sessions.

## How it works

Quartermaster has hooks for setup hints, local tallies, freshness notices, and resupply offers. The hooks do not call a model for the mining pass. The plugin also ships skills for `setup`, `resupply`, `update-toolshed`, and `toolshed-doctor`.

- **Setup** assesses one project, mines a cross-project history summary, asks a short interview, and proposes a project baseline. The Toolshed pieces remain independent and opt in separately.
- **Resupply** mines the current project by default after you approve a round. It ranks missing measurements, manual work, re-derived knowledge, underperforming capabilities, and setup friction, then asks for approval for each finding.
- **Update** runs the requested updater for active Eigenwise Toolshed registry installs, at their recorded user, project, or local scope and project path. It does not update third-party marketplaces.
- **Doctor** is read-only. It checks installed versions, freshness, workspace wiring, and any installed Observability or Model Gateway health it can inspect.

The updater and the freshness hooks have different jobs. `/quartermaster:update-toolshed` changes installs when you request it. Freshness hooks report cached availability or loaded-version mismatches and point to the updater; they do not install or restart anything. Marketplace auto-update is optional and must be enabled for the Eigenwise Toolshed marketplace in Claude Code. An open session still needs `/reload-plugins` after plugin code changes. Process-level gateway wiring or model discovery may need a new Claude Code process.

## Privacy and the history summary

Quartermaster's local script reads Claude Code transcript files from the machine and emits a bounded JSON aggregate. The active model sees that aggregate when the setup or resupply skill reads it. Raw transcript files are not loaded into model context, and the skills are explicitly forbidden from opening them. The scripts make no network calls for this catalog and mining flow.

The aggregate is more than counts. It can include:

- a clipped session title, up to 120 characters;
- the first real user prompt, up to 240 characters;
- explicit goal conditions, whether each goal was met, and bounded goal samples;
- the two directory segments nearest touched files, with scratch and opaque paths removed;
- counts for prompts, tool calls, errors, denials, interrupts, and corrections;
- a denial meaning that identifies `permission-rule` as a host-reported policy block, not proof of
  whether a permission rule or PreToolUse hook blocked the call, except when the hook's own stderr
  is present in the transcript: that case is classified `hook_block`, counted separately, and left
  out of the denial total so one hook-heavy session cannot drown out real denials;
- repeated command names, plugin, skill, and MCP attribution, and fetched hostnames; and
- short clipped user-correction or denial evidence, up to 300 characters per quote; leading harness blocks are excluded from correction evidence.

Setup explicitly requests the all-projects aggregate. Resupply reads the current project by default and only uses `--all-projects` for a global pass. A host policy label alone never justifies a permission allowlist or hook change; existing approval requirements still apply. The state directory stores local tallies and the decision ledger, not raw conversation transcripts. Resupply due checks also stat current-project transcript files, using only their modification time to count activity since a reset; they never open transcript content.

## The setup handoff

Setup installs the approved plugins and writes the approved workspace files. It then stops at the plugin reload boundary. Reload plugins or restart Claude Code when the change affects the process environment, tell Claude `continue`, and let setup verify the result after that boundary. Do not treat an installed plugin as loaded in the current process until the reload or restart has happened.

## CLI

```text
node bin/quartermaster.js mine [--project <path>] [--days 30] [--sessions 40] [--all-projects] [--no-subagents]
node bin/quartermaster.js status [--project <path>]
node bin/quartermaster.js catalog [--query <terms>] [--installed]
node bin/quartermaster.js decisions list
node bin/quartermaster.js decisions add --title <t> --fingerprint <f> --status applied|rejected|deferred ...
node bin/quartermaster.js decisions update <id> --status applied|rejected|deferred
node bin/quartermaster.js decisions remove <id>
node bin/quartermaster.js verify [--project <path>]
node bin/quartermaster.js mark-resupply [--project <path>]
node bin/quartermaster.js decline-resupply [--project <path>]
node bin/quartermaster.js allowlist [--project <path>] [--days 30] [--sessions 40] [--blocked]
node bin/quartermaster.js enable-auto-allowlist [--project <path>]
node bin/quartermaster.js crap [--project <path>] [--max 6] [--base <git-ref>] [--lcov <path>] [--complexity <lizard.csv>] [--coverage-command "<cmd>"] [--cc-only] [--json]
```

Everything prints JSON except `crap`. Node standard library only, no dependencies, cross-platform.

`crap` scores every function in the project with CRAP (Change Risk Anti-Patterns), `cc^2 * (1 - coverage)^3 + cc`, so a function is either simple or covered. Coverage comes from an lcov file, complexity from [lizard](https://github.com/terryyin/lizard), which reads C/C++, C#, Java, JavaScript, TypeScript, Python, Go, Rust, Ruby, PHP, Swift, Kotlin, Scala, Lua and more. It prints one line per offender plus a summary, or the whole report with `--json`.

Settings come from `.claude/quartermaster/crap.json`, and flags override it:

```json
{
  "coverageCommand": "npx c8 --reporter=lcov npm test",
  "lcov": "coverage/lcov.info",
  "sources": ["src"],
  "exclude": ["**/*.test.*"],
  "max": 6,
  "base": "main"
}
```

Every changed or new function has to stay under the ceiling (6; 6 fails), and unchanged functions are not gated. A function counts as changed when it differs from its copy at `git merge-base HEAD <base>`; `base` defaults to the local `develop`, `main`, or `master`. With no base (none of those branches exists, or `base` is `HEAD`) every function is gated. `--ratchet` and the config key `ratchet` still work as a deprecated alias for `--base`/`base`; using either prints a one-line warning.

CRAP is never below cc, so a changed function with cc 6 or more fails at any coverage. The failure line says so (`cc 6 or more fails at any coverage`): split the function, because more tests cannot fix it. `--cc-only` checks exactly that and nothing else. It runs lizard only, with no coverage command and no lcov, applies the same changed-function selection and base, and fails each changed function with cc 6 or more (`cc=<n> fails at any coverage (CRAP is never below cc)`). It exits 1 on a failure and 2 on a missing prerequisite, like the full gate, and takes seconds. Use it while splitting functions, then run the full gate once. It rejects `--lcov` and `--coverage-command`.

The default base is the local branch, never `origin/<branch>`, because a fork's origin can be stale. A local base that lags its upstream makes work already merged there read as changed, so when `git rev-list --count <base>..<base>@{upstream}` is above zero, `crap` prints a one-line warning on stderr naming how many commits the base is behind. Pass `--base <base>@{upstream}`, or fetch and fast-forward the base. The warning never fails the gate.

Exit codes: 0 the gate passed, 1 the gate failed, 2 a prerequisite or measurement is missing (lizard is not resolvable, there is no lcov file, the coverage command failed, or a changed line lies in a function no lizard row of its own measures, a nested function lizard dropped included; the gate corrects the spans lizard misreads and fails closed on what it cannot place). Quartermaster looks for `lizard` on PATH, then `uvx lizard`, then `pipx run lizard`; it never installs it, it prints the install hint (`uv tool install lizard`, `pipx install lizard`, or `pip install lizard`).

## Configuration

Environment variables are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUARTERMASTER_MIN_SESSIONS` | 4 | Unreviewed session activity before a nudge |
| `QUARTERMASTER_MIN_FRICTION` | 6 | Friction events before a nudge |
| `QUARTERMASTER_NUDGE_HOURS` | 24 | Cooldown between SessionStart nudges |
| `QUARTERMASTER_RESUPPLY_HOURS` | 24 | Wall-clock cooldown after an accepted resupply pass |
| `QUARTERMASTER_RESUPPLY_MULTIPLIER` | 2 | Evidence multiplier that can reopen an accepted resupply cooldown after its four-hour floor |
| `QUARTERMASTER_OFFER_HOURS` | 24 | Base cross-session Stop-time offer cooldown; each consecutive decline doubles it |
| `QUARTERMASTER_STATE_DIR` | `~/.claude/quartermaster-state` | Where tallies and the decision ledger live |

## Links

- [Quartermaster guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/quartermaster/)
- [Toolshed plugin reference](https://eigenwise.github.io/eigenwise-toolshed/reference/quartermaster/)
- [Repository](https://github.com/Eigenwise/eigenwise-toolshed)

## Support

Quartermaster's plugin code is free and MIT-licensed. If it saves you time, optional donations through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) support its maintenance. Donations are never required to install or use the plugin.
