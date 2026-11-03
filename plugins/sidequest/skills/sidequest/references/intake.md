# Independent intake review

For each intake review-and-refine cycle, create a ticket in the existing `review-audit` category with `labels: ["intake-review"]`. Both the category and label are required. Dispatch then includes the fixed **Independent intake review** section from `src/lib/agentsync.ts`. An ordinary review ticket gets no intake section.

Use this ticket description template, replacing the placeholders with actual board refs and the current draft:

```text
Review intake cycle <n> for story <US-n>, contract revision <revision>.
Recon tickets and relevant comments: <refs and comment ids>.
Story decision log and current contract: <story ref and revision>.
Draft playback: <requester's words, recorded decisions, and marked inferences>.
Draft questions and recommendations: <full draft, with evidence refs>.
Prior cycle's unresolved findings, if any: <identifiers or none>.

Read the recon comments, story log and contract first. Use the dispatch's
Independent intake review brief. Return decided-vs-ask, ranked gaps,
unsupported recommendations, decision-changing research proposals and at most
four revised human questions, followed by its five-line verdict.
Keep the response under about 3,000 tokens. Propose no design. Write nothing
to the repository. Record the review through normal read-only board completion.
```

The orchestrator refines the draft and records the cycle before the human round. The reviewer cannot approve implementation. Missing evidence stays explicit; settled decisions do not become questions again without contradictory evidence.

One cycle costs one read-only executor (about 5–10 machine minutes, no human round trips). It prevents spending the human round on already settled choices or recommendations without evidence. Solo use needs no tracker, account or server.
