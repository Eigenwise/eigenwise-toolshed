---
name: verify-discipline
description: >-
  Run tests without burning the clock or the context window: narrow checks while you iterate, the
  full suite once at the end. Use when running tests, verifying a change, choosing a test command,
  or when a suite is being re-run repeatedly.
---

# Verify discipline

Shell verification consumed 284.5 of 341 measured minutes over four days on this system. Of 693
runs, 566 came from subagents. The full suite averaged 51.3 seconds across 217 runs, while
file-scoped tests averaged 21.5 seconds across 197. Forty-eight transcripts ran a suite at least
five times and accounted for 520 of 706 runs.

The waste is in repeating a broad gate after every edit. Testing is fine. Testing everything after
every keystroke is where the four days went.

## Narrow while you work, full gate at the end

1. Find the project's real commands first: read `package.json` scripts, the Makefile, or whatever
   the project actually documents. Do not guess flags or carry a command over from another project.
2. Identify the test file or consumer closest to the behavior you just changed. Use the project's
   file-aware test command with that exact file.
3. Run that scoped check after each related edit. When it fails, fix the focused failure and rerun
   only the focused check.
4. Once the scoped checks pass, run the full suite **once**, at the end, before you call the work
   done or hand it off.

If the project has no reliable file-scoped form, use the smallest documented check that covers what
you changed, and keep the full command as the final gate.

Do not use a full suite as an edit loop. Run an extra broad check only when you have touched a new
surface, or when a focused failure points at something outside the code you changed.

## Never stream a passing suite into the transcript

A passing suite's output carries no information. The exit code and the summary counts are the whole
signal, and the rest is thousands of tokens of `ok 1 ... ok 400` nobody will read.

Redirect the run to a log and print only the status and the failures:

```bash
log="$(mktemp "${TMPDIR:-/tmp}/verify.XXXXXX.log")"
(<the full test command>) > "$log" 2>&1
status=$?
printf 'exit=%s\n' "$status"
grep -nE '^not ok|^# (fail|pass)' "$log" | head -40
printf 'details=%s\n' "$log"
exit "$status"
```

The wrapper preserves the command's exit code, so filtering the output never weakens the gate. On a
failure, use the line numbers `grep -n` printed to read only those ranges of the log. Do not dump
the whole thing.

## This matters most for subagents

566 of the 693 measured runs came from subagents, and a subagent's suite output lands in a context
you are paying for and cannot see. When you brief an agent, give it one exact scoped command and one
exact full command, with the wrapper above already filled in. An agent that has to invent its test
command invents a broad one. See `fan-out` for the rest of what a brief needs.

## Guidelines

- **The narrowest reliable check wins** while you iterate. Reliable is the load-bearing word: a
  check that passes while the code is broken is worse than a slow one.
- **Full suite once**, at the seam, when the work is done or several pieces are being merged.
- **Exit code is the verdict.** Read the log on failure only.
- **Hand agents their commands.** Both of them, exact, copy-pasteable.
