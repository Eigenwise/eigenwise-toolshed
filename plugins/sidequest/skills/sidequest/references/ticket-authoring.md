# Ticket authoring

Declare scope by the surfaces a change reaches, not just the first file you found. For a cross-cutting change inside one plugin, declare its `src/lib`, `test`, and, where relevant, `hooks` directories. Use file-granular scope for surgical work where blast-radius control is the point.

## Pinned planning contract

Before dispatching a substantial or ambiguous feature, publish one visible planning checkpoint on its
story, planning ticket, or execution tickets. The authoring orchestrator decides what improvement is worth making,
its concrete benefit, approach, and boundaries before dispatch. Research returns facts and bounded alternatives for
that decision. The implementation ticket records the selected plan; it does not delegate product or tradeoff
choices to its executor. It must name:

1. The intended outcome and explicit non-goals.
2. The smallest source of truth or authority that decides the behavior. Remove ambiguous competing
   authorities or fallbacks when that is the actual ambiguity.
3. The surgical source-file boundary for each piece, and every public surface each piece may change or
   must leave unchanged.
4. One bounded executable done-oracle per piece, including the observed behavior and a regression input
   or consumer that exercises it.
5. The review budget from the feature size, with a reason when the oracle alone is sufficient.
6. Concrete evidence that reopens design, such as an incompatible consumer, a necessary migration, an
   unobservable outcome, or a seam that cannot meet the stated boundary.

A settled feature gets one authored contract. Use two or three bounded proposals only when the approach
is genuinely contested. An exact small edit keeps the lightweight path: record its outcome and oracle,
then use one ticket.

For substantial or safety-sensitive changes, do a short architecture/feasibility preflight before
expensive implementation or tests. Trace shared authority and callers, choose the smallest existing
seam, and consume the dedicated quality owner's real touched-function complexity and measurement
support. Check genuine native baseline/candidate ownership, protected state and dirty prerequisites,
the runnable done-oracle, and its actual timeout/resource fit. Missing measurement stays UNVERIFIED;
Quartermaster owns setup only, never scoring or recurring audits. Leave untouched legacy code outside
measurement scope and preserve standards.

Choose verifiers by observed behavior, callers and real coverage/source identity. Inspect transitive
test-file imports before choosing files or names: `--test-name-pattern` does not stop top-level imports
from registering other suites. A narrow selection can avoid unrelated fan-out while preserving full
measured coverage for touched functions and required final acceptance. Never fabricate a passing
capture or accept a timed-out command because later log text says green; preserve deadlines and
protected assertions.

Pin ordinary next steps within the contract: one producer owns patch, focused regressions, measurement,
clean-candidate capture and submit. Preauthorize those steps, pause only the genuinely blocked step,
and continue unaffected source work. Resource availability and authority changes still need their real
owner's decision. For live advice, name the architectural risk, authorized snapshot/paths, inspection
limits and budget under `readonly-guidance.md`; ask for a plan advisor only when that risk merits it.

Ask the user once, in one batch, only for choices that change user-visible behavior, compatibility,
migration, public API, dependency, or expensive-to-reverse scope. Explicit current-feature delegation
("do your thing", "use your judgment", or "whatever you think") lets the author decide and record the
choice; it never establishes a durable preference.

## Sidequest category and config schema

A Sidequest category or config-schema change normally spans `src/lib/store.ts`, `src/lib/category-defaults.ts`, `src/lib/exec-names.ts`, `src/lib/agentsync.ts`, `src/lib/mcp.ts`, `src/bin`, `SKILL.md`, and their tests. Include `category-defaults.json`, `mcp-tool-descriptors.json`, and `cli-goldens.json` fixtures/goldens, plus generated `hooks/*.js` when the change reaches hooks.

Decide explicitly whether existing materialized profiles need a seed catch-up. Put that decision and the exact verify command in the ticket description.

## Describe implementation work

Descriptions are developer-to-developer specs, never PM summaries. Include anchors, behavior and edge cases, bounds, dependencies or decisions, and a runnable `cd <repo-relative-dir> && ...` verify command. Bugs include a reproduction. Front-load evidence needed to implement the selected plan. Route by remaining uncertainty, not original difficulty: a settled one-or-two-file edit is `coding.easy`; use direct only for the INLINE-SAFE allowlist, with its recorded reason.

Anchors are checked against the repo, so write prose freely and mark real symbols. A path is always verified. A token before `in <path>` or `is at <path>` is verified as a source symbol only when it is backticked or shaped like code (an underscore, a `$`, or a camelCase hump), which is why ordinary sentences such as "the check lives in `src/foo.ts`" no longer report `lives` as a missing symbol. Backtick an all-lowercase identifier when you do want that check.

## Establish the premise and acceptance behavior

A quantitative or behavioral claim that a fix depends on needs evidence before it becomes a ticket premise. Include the measurement command, its output, and where it ran, or link the read-only measurement ticket that established the numbers. When the claim has not been measured, file measurement work first and create the fix ticket from that result.

State the behavior that must keep working, the regression input or consumer that would expose a break, and what a useful failure should identify. The verification oracle must observe that property on produced output. Greps for class names, function names, route names, or other implementation identifiers are diagnostics only because another implementation can reproduce the same broken behavior. Add or update the smallest meaningful runnable regression needed to prove the behavior; do not invent a test count.

For overlapping wave changes, treat source anchors as baseline hints. Write acceptance against the assembled behavior and rerun that property oracle after the terminal wave is assembled, before publish.

## Carry paid recon into the ticket

For every touched surface, include a `file:line` anchor and the relevant excerpt from the authoring
recon. The executor starts where you left off, never cold. This removes orientation work, which is
31% of executor calls and costs about 60k cache-read tokens each.

## Review-gated acceptance

Before the first dispatch, give review-gated work adversarial acceptance criteria: name the exact
bypass classes the reviewer must probe, not a generic "review it" request. Review checks the pinned
contract and its done-oracle. Unrelated findings become separately prioritized tickets and block the
active ship only when the contract or a proven regression requires it.

After two independently rejected candidates in one defect chain, stop local patching. Re-plan, narrow
the contract, or replace the authority or architecture before another candidate; involve the user when
the feature was not delegated. Do not dispatch a third local patch against the same unexamined premise.
