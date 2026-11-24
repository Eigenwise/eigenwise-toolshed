# No "filed by this session" field on a ticket

2026-11-19

**Asked:** stamp each ticket with the id of the session that filed it, so a later session can tell its own earlier work from someone else's leftovers.

**Evidence:** the session id was seen in a run for each way a conversation carries on (Claude Code 2.1.328). `--resume`, `--continue` and a desktop app restart keep it. `/clear`, and quitting and starting again in the same folder, give a new one. The failure this was meant for is a person who stops, starts fresh and asks for something else, which is exactly the case where the id changes. So the field would call a person's own work from ten minutes ago "someone else's", and would call it "mine" only where the conversation already remembers it.

**Decision:** No session id on a ticket. What a ticket needs to say is whose words started it, and the board writes that from the turn it happened in (`ARCHITECTURE.md`, statuses). `startedBy: session` stays, for work the session opened by itself.

**Would change if:** the host gives a mod an id that follows one person across `/clear` and a fresh start, and a real run shows two people's tickets mixed up on one board.
