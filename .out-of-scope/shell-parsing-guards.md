# No shell-parsing guards

2026-11-16

**v1 had:** hooks that read Bash and PowerShell command text to refuse destructive git forms, home-directory deletes, unparseable `cd`, heredocs and write commands from read-only executors.

**Evidence:** Across #550 to #699 there were 12 guard issues, all false positives, with no report of a guard stopping real damage. One guard refused commands the executor briefing told executors to run: 1,263 refusals in 551 of 917 executors, 27% of their tool errors (#422). Many were the host's own check.

**Decision:** Read-only roles are agent types without write tools. Destructive commands go through the host's permission rules. We do not parse shell text.

**Would change if:** a v2 incident destroys work that a native permission rule could not have asked about.
