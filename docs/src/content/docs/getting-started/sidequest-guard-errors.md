---
title: Sidequest guard errors
description: Read a guard refusal or transient error notice.
---

Sidequest checks each Git command in a compound shell invocation. A leading `cd /path/to/repo &&` sets the directory for the following Git command. Chained relative `cd` commands and semicolon-separated commands keep their own directory context. Git's `-C` resolves from that context.

The usual safety rules still apply. A reset that would discard dirty shared-checkout work is refused. Publication commands still require the current session's publish lock when they target the published branch. A refusal blocks the entire shell invocation, including earlier segments.

If a push or tag targets a directory that does not exist yet, the guard names the missing directory and refuses before starting Git. Run the directory-creating command first, then run the push or tag as a separate command after the directory exists. This applies to chains starting with `git worktree add`, `git clone`, or `mkdir`, too.

When a directory expression cannot be resolved safely, such as `cd "$TARGET"`, the refusal names the command segment it could not parse. Use a literal directory path so the guard can check the repository that Git will use.

If a guard fails internally, its diagnostic names the guard, tool, and error. Sidequest writes it to the debug log and shows a transient toast. Permission and destructive-operation guards refuse the unchecked call. Advisory guards, such as repeated-command warnings and inline-work nudges, let the call continue with that diagnostic. The toast expires instead of leaving a stale status line behind.
