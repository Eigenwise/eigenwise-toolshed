---
name: audit-rules
description: Check .claude/rules/ for dead globs, oversized or duplicate rules and leftover v1 keys. Use when rules seem ignored or context feels heavy.
---

# Audit the rules

Run the script from the project root and read the result:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-rules.mjs" --rules .claude/rules --table
```

It needs Node 22.5 or later. If Node is missing or older, say the audit cannot run here and stop. Drop `--table` for JSON. Add `--file <path>` to look at one rule. For user scope use `--rules ~/.claude/rules`.

The script reads files only. It exits 0 unless a file cannot be parsed, so a clean exit does not mean no findings. Read the table.

## Findings and their one fix

| Code | Meaning | Fix |
| --- | --- | --- |
| `parse-error` | The frontmatter cannot be read. The rule is not loading. | Open the file, fix the line it names. Each frontmatter line is `key: value` or `- item`. |
| `ignored-field` | A v1 key (`globs`, `dirs`, `prompt`, `include`, `priority`, `enabled`) sits in a native rule. Claude Code ignores it, so the rule may be loading everywhere. | Apply the fix in the finding. |
| `no-match` | A `paths` glob matches no file in the project. | Correct the glob. Delete the rule if that code is gone. |
| `over-budget` | The body is over 1.5 KB for an always-loaded rule, or 2 KB for a path-scoped one. | Trim it. For an always-loaded rule, adding a `paths` glob is usually better. Otherwise split it by concern. |
| `possible-duplicate` | Two rules have the same paths and a shared heading. | Merge them or delete one. It is a hint, so read both first. |

The audit skips the codebase map (`codebase-map.md` and `map/`), which has its own limits and status check, and says so in one line. Files under `guides/` are audited like any rule.

The last line of the table is the total always-loaded bytes. Every byte there is paid for in every session. If the number is large, point at the biggest always-loaded rules and ask whether each really applies everywhere.

## How to report

Lead with what is wrong and how bad it is. One line per finding: file, problem, fix. Do not apply the fixes without being asked, since rules are the user's standing instructions. When asked, edit the file and run the audit again to show it is clean.

Glob matching uses `git ls-files`, including untracked files git does not ignore. Outside git it walks the directory and skips `node_modules`. Matching follows gitignore rules, the same as the engine.
