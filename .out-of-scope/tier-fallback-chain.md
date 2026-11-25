# No fallback chain on a tier

2026-11-18

**Asked:** an ordered list of fallbacks per tier, so a provider that runs out of quota in the middle of a wave moves on to the next model quietly, and any other failure says so once.

**Evidence:** the board's logs hold 42 routed spawns over three days. None used a tier's fallback, and no run was lost to a provider running out. A chain is a new config shape with two kinds of failure to tell apart, and nothing has failed for it yet.

**Decision:** A tier keeps one `fallback`. When it is used, the reason is named on the ticket's log or in that turn's toast, as `ARCHITECTURE.md` says under Routing. Decided by default, on the recommended answer. It can be reopened.

**Would change if:** a real run loses work because the one fallback was also out, seen in a session doing work a person asked for.
