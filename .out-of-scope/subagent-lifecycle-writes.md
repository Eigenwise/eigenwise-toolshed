# No lifecycle writes from subagents

2026-11-16

**v1 had:** executors that claimed, submitted and closed their own tickets over MCP, with dispatch tokens, nonces, launch names and identity binding to prove which agent was calling.

**Evidence:** The host never tells a hook which ticket an agent belongs to, so v1 rebuilt it from scraps. `dispatch.ts` alone is 5,706 lines, with 61 functions about crossed, parked, guessed or swapped identities. About 65% of the 51,382 lines of Sidequest source protect earlier machinery.

**Decision:** Subagents get a brief and return one structured result. The main session is the only writer of tickets and proposals.

**Would change if:** a v2 failure shows a result lost between a subagent and the main session that a retry could not recover.
