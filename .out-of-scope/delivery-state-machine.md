# No delivery state machine

2026-11-16

**v1 had:** a 12-state attempt machine, four claim timers (15 minutes, 60 minutes, 6 hours, 24 hours), submissions, waves, delivery proofs and a completion pipeline.

**Evidence:** In the window #700 to #844, 94 of 97 Sidequest issues sit in this layer, not in the board or routing. Seventeen more say the model of scope and provenance is too narrow for real git: merges, squashes, chains, story branches (#706 to #709, #746, #757, #843).

**Decision:** A ticket has seven statuses and the human can move it to any of them. Git answers whether work landed. A run is live while its Agent call is.

**Would change if:** a v2 failure shows work lost or double-landed that a branch, a commit and the ticket log could not explain.
