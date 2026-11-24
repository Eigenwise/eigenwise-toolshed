# No release train

2026-11-16

**v1 had:** a release engine with fragments, a changelog, cut and finalize scripts, release and sync branches, and a gate on a completed test run for each step.

**Evidence:** 383 releases in 109 days. 1,644 commits (26%) only touched fragment files. About 61% of pull requests were the maintainer moving commits between his own branches. The engine was 3,441 lines with 3,713 lines of tests. One release took 2h19m and 111 CI minutes to ship three fixes. Failed cuts left live release commits behind.

**Decision:** One branch, one check, version in `plugin.json`, the release commit's message is the changelog. See `RELEASING.md`.

**Would change if:** many people consume pinned versions and need batched, announced releases.
