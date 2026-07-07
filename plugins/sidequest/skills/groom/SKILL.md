---
name: groom
description: >-
  Run a full board-grooming pass over a sidequest project, like a sprint grooming session: sweep every
  ticket, cross-check it against reality (git log, docs, recent session work) to find done-but-open
  tickets, superseded ones, stale claims, duplicates, and missing tickets for work that already exists in
  the repo, then act on what's clearly safe and batch the unclear ones into a few interactive questions
  for the user before closing anything ambiguous. Use when the user says "groom the board", "board
  grooming", "sprint grooming", "clean up the board", "tidy tickets", "audit the tickets", or "is the
  board still accurate". Never deletes tickets (closes with an evidence-bearing comment instead) and
  never touches a claim held by an active agent.
---

# groom

A grooming pass is a periodic reality check on the board, not a one-off cleanup. Tickets drift: a fix
lands but the ticket stays open, a decision supersedes an old plan, an agent claims something and goes
idle, two tickets describe the same work from different sessions, or a real chunk of work landed in the
repo with no ticket ever filed for it. This skill runs that check end to end: sweep, categorize, act on
what's safe, ask about what isn't, apply the answers, report.

**Reference workflow this is modeled on:** the 2026-07-07 temporal-RL grooming pass — 17 tickets closed
with evidence-bearing notes, several stale claims released, and new frontier tickets filed with
`depends-on` links for the work that had already been decided but never ticketed. That's the shape a good
pass takes: mostly mechanical cleanup, a handful of real judgment calls surfaced to the user, nothing
silently dropped.

## Guardrails (non-negotiable)

- **Never `sidequest rm` a ticket.** Closing means `sidequest update <ref> --status done`, not deletion.
  If a ticket is genuinely bogus (duplicate, never should have existed), close it with a comment
  explaining why — the record stays, just off the active board.
- **Never touch a claim held by an active agent.** Only release a claim that is actually stale: `doing`,
  claimed by someone, and idle past the claim TTL (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 minutes — check
  the ticket's claim timestamp against "now"). If a claim is recent, leave it alone even if you don't
  recognize the `--by` — another session may genuinely be mid-work. Never pass `--force` to `release` or
  `claim` during a grooming pass; force overrides a *live* claim, which is exactly what this guardrail
  forbids.
- **Every closure needs evidence.** A ticket only moves to `done` (or gets marked superseded) with a
  comment that cites something concrete — a commit hash, a file path, a doc section, or a quoted decision
  from another ticket's thread. "Looks done" is not evidence; `git log --oneline -- <path>` turning up the
  actual commit is.
- **Don't guess on the unclear ones.** Anything you can't back with evidence goes to the interactive
  round below instead of being closed or left open on a hunch.

## Step 1 — Sweep

Pull the full board and the recent project history in parallel:

```bash
sidequest list --json                      # every open ticket, this project
sidequest list --status doing --json       # claims in flight, with claim.by / claim.at
sidequest list --archived --json           # already-archived, for duplicate-checking only
git log --oneline -30                      # what actually landed recently
```

For each open ticket, read its thread before judging it — a prior agent may have already left the
evidence you need:

```bash
sidequest comments <ref>
```

Then cross-check each ticket against reality: does the repo already contain the change it describes
(`git log --oneline -- <path>`, `git log --grep "<keyword>"`, read the file itself)? Does a newer ticket
or a doc override its plan? Is its claim stale?

Also sweep the other direction — **work with no ticket**: skim recent commits and any docs/changelogs
for changes that don't trace back to an open or done ticket. That's a gap, not a cleanup, and it's filed,
not fixed, in this pass (see Step 3).

## Step 2 — Categorize

Sort every ticket (and every untracked chunk of repo work you found) into one bucket:

- **(a) Done but still open** — the change is in the repo/docs already. Evidence: a commit or file diff
  that matches the ticket's ask.
- **(b) Superseded** — a later decision (another ticket, a doc, a design change) replaced this ticket's
  plan. Evidence: the superseding ticket/doc/commit.
- **(c) Stale claim** — status `doing`, held by an agent, `claim.at` older than the TTL, no sign of
  active work (no recent comment, no matching recent commit). Evidence: the claim timestamp vs. now.
- **(d) Duplicate/overlap** — two or more open tickets describing the same work. Evidence: both refs,
  quoting the overlapping ask.
- **(e) Missing ticket** — real work found in the repo/docs with no corresponding ticket at all.
- **(f) Unclear** — anything that doesn't cleanly fit (a) through (e): ambiguous scope, contested
  relevance, a ticket that might still matter depending on a plan you can't confirm, one where the
  "evidence" you found is circumstantial rather than solid.

Keep a running list per bucket as you go — you'll need it for both the act step and the report.

## Step 3 — Act on the safe ones

Everything in (a)–(e) gets acted on now, each with a real command and, for closures, a cited comment:

```bash
# (a) done but open — close with the evidence
sidequest comment SQ-12 -m "Already shipped: see commit a1b2c3d (2026-07-05), which added the retry
path this ticket asked for. Closing as done."
sidequest update SQ-12 --status done

# (b) superseded — close, point at what replaced it
sidequest comment SQ-9 -m "Superseded by SQ-40's design: the plan changed from per-request retries to
a single backoff queue (see SQ-40 comment thread, 2026-07-06). This ticket's original approach won't be
built."
sidequest update SQ-9 --status done

# (c) stale claim — release, don't force, only past TTL
sidequest release SQ-21 --by <you> --status todo
sidequest comment SQ-21 -m "Claim by agent-xyz from 2026-07-05T10:00Z was idle past the 60min TTL with
no matching commit or comment since. Released back to todo."

# (d) duplicate — close the newer/thinner one, point at the survivor
sidequest comment SQ-33 -m "Duplicate of SQ-31 (same ask: retry queue for the ingest worker, filed a day
earlier). Closing this one; work continues on SQ-31."
sidequest update SQ-33 --status done

# (e) missing ticket — file it, with complexity + why, link it if it depends on something
sidequest add -t "Backfill retry metrics dashboard" --complexity 5 \
  --why "one Grafana panel + one counter in the retry path; scoped, known pattern" \
  -d "Work exists in commit a1b2c3d but was never ticketed. Filing after the fact so it's tracked."
sidequest link SQ-50 depends-on SQ-31
```

Normalize priorities while you're in each ticket if one is obviously miscalibrated against what you now
know (e.g. a "todo/low" ticket for something that turned out urgent, or vice versa) — but only when the
evidence you already gathered supports the change; don't relitigate priority calls that aren't part of
what you found.

## Step 4 — Batch the unclear ones interactively

Don't guess on bucket (f). Group the unclear tickets into a small number of `AskUserQuestion` rounds (2-4
questions per round is plenty) — one question per unclear ticket or tightly related cluster, each with a
short context summary and options like `keep` / `close` / `re-scope`:

- Question text: `"SQ-17 — is this still relevant?"`
- Context: 1-3 sentences on what the ticket asks, what you found that made it unclear, and why you
  didn't just decide yourself.
- Options: `keep as-is`, `close (superseded/done/dropped)`, `re-scope (needs new complexity/description)`,
  plus a free-text option if the tool supports one.

Present real findings, not a vague "not sure about this one" — the point of asking is that you already
did the legwork and the last mile is a judgment call only the user can make (priorities, whether a
feature is still wanted, whether a plan changed for reasons not visible in the repo).

## Step 5 — Apply the answers

For each answered question, act immediately using the same evidence-comment discipline as Step 3 — the
user's answer *is* the evidence now, so cite it:

```bash
sidequest comment SQ-17 -m "Per grooming pass 2026-07-07: user confirmed this is superseded by the new
plan (dropped in favor of X). Closing."
sidequest update SQ-17 --status done
```

If the answer is "keep", leave the ticket untouched but note in the report that it was reviewed and
confirmed. If "re-scope", update the description/complexity per what the user said and say so in a
comment on the ticket.

## Step 6 — Grooming report

Close the pass with a short report back to the user (chat, not a ticket comment) covering:

- **Totals**: how many tickets swept, how many touched, broken down by bucket (a)-(f).
- **What changed and why**: a compact list — ref, what happened (closed/released/filed/linked), one-line
  evidence citation.
- **What was asked and decided**: each interactive question, the option picked, and what you did about it.
- **Anything still open/unresolved**: an `await` still pending, a question the user didn't answer, or a
  bucket-(f) item you couldn't even turn into a good question yet.

Keep the report plain and specific — refs, commit hashes, file paths — not a vague "cleaned things up."

## Guidelines

- **Evidence over inference.** If you can't point at a commit, doc, or comment, it's unclear — ask, don't
  assume.
- **One pass, not endless polling.** Sweep once, act once, ask once (in a small batch), report once.
  Don't re-open the same ticket for a second guess mid-pass.
- **Respect other agents.** A recent claim, a recent comment, an in-flight `doing` ticket with signs of
  life — leave it. Grooming is for drift, not for interrupting live work.
- **Scope to one project per pass** unless the user asks for a cross-board sweep — pass `--project` the
  same way any other sidequest command does if they want another board.
