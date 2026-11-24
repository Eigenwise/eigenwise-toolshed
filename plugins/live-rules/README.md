# live-rules

Write and check project rules. Claude Code loads `.claude/rules/` on its own, so this plugin has no hooks and runs no process. It is the authoring and audit side.

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2
```

```bash
claude plugin install live-rules@toolshed-next
```

## What you get

| Skill | Does |
| --- | --- |
| `add-rule` | Turns "from now on, when X, do Y" into the right file, then audits it. |
| `audit-rules` | Runs the audit script and explains each finding with its one fix. |

## How rules load

These are the facts the plugin builds on, checked against the Claude Code 2.1.325 binary.

- A file in `.claude/rules/` with no `paths` key loads at session start and after compaction.
- A `paths` key makes it conditional. It loads when Claude touches a matching file. The value is a list, or one comma separated string, and braces expand (`src/**/*.{ts,tsx}`).
- Matching uses gitignore rules. A pattern with no slash matches at any depth, and a directory name covers everything under it.
- A trailing `/**` is dropped. An empty list, or a list of only `**`, means always loaded.
- Plugins cannot ship rules. A rule is a project file, so it works for a teammate who never installed this plugin. Commit it.
- Rules cannot match words in a prompt. A keyword trigger is a skill, and its description is the trigger.

## add-rule

Asks one thing it cannot infer: where the rule applies. Always, a glob, a directory, or a prompt keyword.

- Always, glob and directory become `.claude/rules/<name>.md`, with `paths` when scoped.
- A keyword or a procedure becomes `.claude/skills/<name>/SKILL.md`.
- Project scope is the default. User scope (`~/.claude/rules/`) only when you ask.
- One concern per file, a H1 that says the rule, a few imperative lines.

It finishes by running the audit on the new file and showing the result.

## The audit script

From a checkout of this repository (an installed copy has the same scripts in its install folder, and the skills run them for you):

```
node plugins/live-rules/scripts/audit-rules.mjs [--rules <dir>] [--root <project>] [--file <rule>] [--table]
```

Dependency-free Node, and it needs Node 22.5 or later. Older Node stops with one line saying so. The defaults are `.claude/rules` and the project two levels above it. Output is JSON, or a table with `--table`. Findings:

| Code | Meaning |
| --- | --- |
| `parse-error` | Frontmatter cannot be read (indented continuation lines and `>` or `|` block values are fine). The only finding that makes the exit code 1. |
| `ignored-field` | A v1 key such as `globs` or `priority` in a native rule. Claude Code ignores it. |
| `no-match` | A `paths` glob matches no file. Files come from `git ls-files` (tracked, plus untracked files git does not ignore). Outside git it walks the directory. |
| `over-budget` | Body above 1.5 KB for an always-loaded rule, 2 KB for a path-scoped one. |
| `possible-duplicate` | Same paths and a shared heading as an earlier rule. |

The codebase map is not audited: `codebase-map.md` and everything under `map/` are skipped, with one line in the table saying so, because the map has its own limits and its own status check. Files under `guides/` are ordinary rules and are audited.

It also reports the total always-loaded bytes, which is what every session pays. Glob matching is skipped when the rules folder belongs to your home directory, since no project applies.

## Tests

```
node --test "scripts/*.test.mjs"
```

Temp-directory fixtures, no network, no model calls. Node 22 treats a bare directory argument as a module path, so give it the glob.

## Limits

The glob matcher uses Node's `path.matchesGlob` with gitignore anchoring added. It is close to the engine's matcher but not the same library, so a rare edge case (negation, escapes) can differ. A `no-match` warning on a rule for files that do not exist yet is expected.
