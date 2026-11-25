# No scope enforcement at commit

2026-11-16

**v1 had:** declared file scopes per ticket, a commit-time check (`commit-scope.ts`, 1,103 lines), scope requests, grants, auto-approval and special handling for release fragments.

**Evidence:** Seventeen issues in #700 to #844 say scope and provenance break on real git (#706 to #709, #746, #757, #779, #783, #787, #804, #843). A ticket with no declared scope was a guaranteed dead end. One ticket's release-fragment declaration blocked two unrelated green siblings. Release-fragment rules leaked into the product (#147, #515, #660, #686, #757, #830).

**Decision:** Compare the net three-dot diff against the ticket and warn in review. Nothing refuses a commit or a submit.

**Would change if:** a v2 incident shows an agent changing files that a reviewer could not have seen in the diff.
