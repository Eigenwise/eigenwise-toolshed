# No lease, heartbeat, claim or timeout on a ticket

2026-11-19

**Asked:** a ticket in `doing` holds a lease its agent renews, so a run that died is noticed, its ticket is released after a timeout, and two sessions cannot both take it.

**Evidence:** v1 had this for worktrees: 3,234 lines of lease, sweep, quarantine and salvage, and it refused edits inside an agent's own worktree four times (#98, #163, #232, #840). A heartbeat needs a write per tool call or a timer, and both break a hard rule: zero processes per tool call, nothing running while idle. The one real failure in v2 (2026-11-19) was the opposite of a stuck lease: a ticket the person had set aside was picked up again. A timeout that releases a ticket by itself is one more way for that to happen.

**Decision:** Interrupted is a label worked out when someone looks: a `doing` or `review` ticket with no live run in this session, with when its worktree and transcript last changed ("files changed 40s ago", "last activity 3h ago"). Nothing is written, nothing expires, nothing is released. The person says resume, set aside or drop.

**Would change if:** two sessions are seen building the same ticket at once in a real run, and the label did not stop it.
