---
name: verify-discipline
description: Keep Sidequest executor verification focused while iterating and run the ticket gate once before submit.
---

# Verify discipline

Shell verification consumed 284.5 of 341 measured minutes over four days. Of 693 runs, 566 came from subagents. The full suite averaged 51.3 seconds across 217 runs, while file-scoped tests averaged 21.5 seconds across 197. Forty-eight transcripts ran a suite at least five times and accounted for 520 of 706 runs. The waste comes from repeating a broad gate after every edit, not from testing itself.

Use the narrowest reliable check while you work. Save the ticket's full verification gate for the end.

1. Read the ticket's recorded verify command and inspect the project's package scripts or equivalent task configuration. The ticket command is the submit gate.
2. Identify the test file or consumer closest to each changed behavior. Use the project's documented file-aware test command or runner syntax with that exact file. Do not guess flags or copy commands from another project.
3. Run that scoped check after a related edit. If it fails, fix the focused failure and rerun only that focused check.
4. When the scoped checks pass, run the ticket's recorded verify command once immediately before submit. Follow any ticket-specific verify-liveness markers around that command.

Never stream a full suite into the transcript. A passing suite's full output carries no information: the exit code and summary counts are the whole signal. Redirect the full gate to a temporary log, then print only the status and TAP summary:

```bash
log="$(mktemp "${TMPDIR:-/tmp}/sidequest-verify.XXXXXX.log")"
(<ticket verify command>) > "$log" 2>&1
status=$?
printf 'exit=%s\n' "$status"
grep -nE '^not ok|^# (fail|pass)' "$log" | head -40
printf 'details=%s\n' "$log"
exit "$status"
```

On failure, use the reported line numbers to read only the relevant log ranges around `not ok`; do not dump the whole log. The wrapper preserves the test command's exit code, so output filtering never weakens the submission gate. A ticket briefing may already provide this wrapper with its exact command filled in.

A project may expose a file-scoped test script, a runner that accepts test-file arguments, or another narrow consumer check. Derive both the focused command and the full gate from this project's recorded ticket command and task configuration. If no reliable focused form exists, use the smallest documented check that covers the changed behavior, then preserve the full ticket command as the final gate.

Do not use a full suite as an edit loop. Run additional broad checks only when a new changed surface needs one, an explicit ticket contract requires one, or a focused failure points beyond the local behavior.
