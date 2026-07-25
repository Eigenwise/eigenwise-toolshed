# Why live-rules exists

A rule can be correct and still arrive at the wrong time.

Put every instruction in `CLAUDE.md` or `AGENTS.md`, and the agent gets a useful brief at a fixed loading point. That works well for stable project facts: where the tests live, which package manager to use, or the project's general writing style. It gets awkward when a rule matters only for one kind of file, one directory, or one kind of request. A deploy checklist does not belong in the context for every bug fix. A SQL safety rule does not need to compete for attention while editing a Markdown file.

The other problem is salience. Claude Code says that `CLAUDE.md` is context, not enforced configuration, and there is no guarantee that every instruction will be followed. The project-root file survives compaction because Claude Code reads it from disk again, but a normal hand-edit during an active session has no equivalent live reload. Codex builds its `AGENTS.md` instruction chain once per run. Editing an active file requires a new command or run.

live-rules exists for guidance that needs to show up when it applies, can change while a session is running, and should not occupy every turn when it does not apply.

## The useful difference

`CLAUDE.md` and `AGENTS.md` are instruction files. live-rules is a small delivery layer for instruction files. It uses Claude Code hooks to choose rules from the current prompt, working directory, and file about to be edited.

The plugin stores rules as Markdown files with frontmatter. A rule with no scope is global. A rule with `globs` matches an edited path. A rule with `dirs` matches a directory. A rule with `prompt` matches literal keywords or a regular expression in the prompt. Scopes can be combined, and a rule fires when any of its declared conditions matches.

That changes the timing:

- `SessionStart` provides a safety-net pass for global rules and resets the per-session seen-hash ledger.
- `UserPromptSubmit` can see the prompt and current working directory, so it delivers global, keyword, and directory rules when their content hash is new to the session.
- `PreToolUse` can see the file Claude is about to edit, so it delivers matching glob and directory rules immediately before the edit.

The hooks read the rule files fresh on each event. Edit a rule, and the changed content can apply on the next prompt or matching edit without restarting the session. The hash ledger keeps unchanged rules from being charged again after they have already been grounded in that session. A context reset starts the ledger over, so rules can be grounded again when needed.

This is the core idea: put a rule next to the event that makes it relevant, rather than asking one permanent brief to carry every possible rule all the time.

## Comparison with CLAUDE.md and AGENTS.md

| Question | `CLAUDE.md` | `AGENTS.md` | live-rules |
| --- | --- | --- | --- |
| When does it load? | Claude Code loads discovered files in full at session start. Nested files can load lazily when Claude reads files in those directories. The project-root file is re-read after compaction. | Codex builds an instruction chain once when a run starts, scanning from the project root toward the launch directory. | Hooks run at session start, prompt submission, and before matching edit tools. Each event has a different view of what is relevant. |
| How does scope work? | Files are found by directory position. Claude Code also supports `.claude/rules/` with `paths:` frontmatter, loaded when matching files are read. | The closest file to the edited file wins. The format has no required conditional schema. | Global, glob, directory, and prompt-keyword scopes can be combined with OR semantics. |
| Can it reload? | A hand-edit is not a general mid-session reload mechanism. Root instructions come back after compaction; nested rules load when their directories are read. | No. Codex documents that changing an active file requires a new run. | Rule content is read fresh on each hook event, so a changed rule can apply on the next prompt or matching edit. Plugin hook registration still needs `/reload-plugins` or a restart after installing or updating the plugin. |
| What does it cost? | Discovered files and imported `@path` content are loaded into context. Imports organize content but do not remove that cost. | The merged instruction chain is loaded for the run. | Only matching rules are selected, and the per-session hash ledger skips unchanged content after first grounding. Hook output still shares Claude Code's 10,000-character `additionalContext` cap. |
| Who can use it? | Claude Code. To share content with other tools, Claude Code can import or symlink `AGENTS.md`. | A cross-tool open format supported by many agent tools, including Codex. | A Claude Code plugin, so it is tied to Claude Code's hook system. |
| How visible is loading? | Claude Code provides `/context` and `/memory` views for its memory and context state. | The cited Codex documentation describes resolution order but does not document an equivalent troubleshooting command. | The plugin's session-start banner is a wiring check, and its skills explain which rules are active for an edit. |
| What can fail? | Instructions are context, not enforcement. A vague or buried rule can simply be missed. | A rule can be absent from the run's discovered chain, and the documented fix for changes is a new run. | It is deliberately fail-soft: errors and missing files produce no output and do not block an action. Older Claude Code clients can silently drop `additionalContext` for `PreToolUse`, and hook registration can stay stale until `/reload-plugins` or a restart. |

The table describes different jobs, not a single winner. `AGENTS.md` has a real portability advantage. `CLAUDE.md` is simpler and is the right place for instructions that must be present from the start of every Claude Code session. live-rules adds conditional delivery and fresh content reads inside a session, at the cost of a plugin, hook wiring, and more storage machinery than a plain Markdown file.

## Examples

Keep universal instructions in `CLAUDE.md` or `AGENTS.md`:

```markdown
# Project guidance

Run `npm test` before opening a pull request.
Use the repository's existing package manager.
```

Those rules are useful before the agent has looked at any particular file, and other agents may need them too.

Put an always-on rule in live-rules only when it is still useful to re-ground it after a context reset:

```markdown
---
description: Commit hygiene
---
- Do not commit directly to main.
- Run the affected tests before committing.
```

Use a path-matched rule for guidance that belongs to one file family:

```markdown
---
description: SQL safety
globs: ["*.sql"]
---
- Use parameterized queries.
- Test a rollback for every destructive migration.
```

Use a prompt rule for a workflow that starts with a request:

```markdown
---
description: Deploy checklist
prompt: ["deploy", "release", "/ship.*prod/i"]
---
- Confirm staging smoke tests passed.
- Bump the version and update the changelog.
```

When Claude is about to edit a matching SQL file, the SQL rule is delivered by `PreToolUse`. When you submit a prompt containing `deploy`, the deploy rule is eligible through `UserPromptSubmit`. An unchanged rule is then skipped for the rest of that session by its seen hash, until a reset or a content change makes it eligible again.

## The limits matter

Scoping reduces unnecessary delivery. It does not create an unlimited context budget. A project with too many active global rules can still hit the same hook output ceiling that any other large instruction payload would hit. Keep global rules short and make scopes specific.

live-rules does not enforce behavior. Its edit hook adds context and never sends a permission decision. Hard blocks require a separate permission or hook mechanism, with its own contract and tradeoffs.

The plugin is Claude Code-specific. It cannot match `AGENTS.md`'s cross-tool reach. It also has a plugin-specific operational dependency: after installing or updating live-rules, run `/reload-plugins` or restart Claude Code so the new hook registrations are active. Older clients may silently drop `PreToolUse` context, which can make path and directory rules appear to do nothing.

A small project with a short, stable instruction file may not need any of this. The frontmatter, manifest, hashes, migration path, and hooks are extra moving parts. Use them when conditional timing, in-session updates, or repeated grounding solve a real problem.

## Use both

Use `CLAUDE.md` for the permanent project brief and stable instructions that must be available at turn zero. Use `AGENTS.md` when the guidance should travel across agent tools. Use live-rules for conditional rules, path-specific guardrails, prompt-triggered workflows, and content that should be picked up without a new run.

They work together. The static files explain the project. live-rules brings the narrower rule forward when the current prompt or edit makes it relevant. That split keeps the baseline readable while giving time-sensitive guidance a delivery point closer to the work it governs.

## Sources

The comparison above is based on these first-party sources and the current live-rules implementation:

- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [AGENTS.md open specification](https://agents.md/)
- [OpenAI Codex AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [live-rules hook implementation](./hooks/)
