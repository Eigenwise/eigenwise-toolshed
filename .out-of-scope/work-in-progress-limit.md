# No limit on how much is in progress

2026-11-19

**Asked:** cap how many tickets can be `doing` at once (per session or per board), and refuse or queue a start past the cap, so leftovers cannot pile up.

**Evidence:** four caps were written into v2 once and withdrawn before they shipped, by a decision on 2026-11-19: no artificial limits. A cap that refuses a start stops a person's work for a number nobody measured. The pile-up it aims at comes from interrupted runs that stay `doing`, and the interrupted label already shows those for what they are.

**Decision:** No cap and no gate. What is running, what is interrupted and what is old show on the pane, and the person decides.

**Would change if:** a real run is slowed or broken by too many agents at once, with the count that did it.
