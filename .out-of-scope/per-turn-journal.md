# No journal or handoff block written every turn

2026-11-19

**Asked:** the session writes where it is after every turn (what it was doing, what comes next), so an interrupted run can be picked up from the journal.

**Evidence:** in the one real failure (2026-11-19), two written records of "what comes next" were the cause: a park note saying the ticket picks up after the first task, and a compaction summary that carried it forward as pending work. A journal with a "next" in it is a third. It also costs tokens on every turn for a note that is read only after an interruption. Most of what it would hold can be read when it is needed: the diff against the base, the commits in order, uncommitted files, the last failing check.

**Decision:** The where-I-was note is the report an agent already writes when it stops: the goal, what is verified, what is not, where it stopped, said as a state and never as a next step. The rest is worked out at view or resume time.

**Would change if:** resumed tickets in real runs redo work that a note would have saved, and the derived facts did not cover it.
