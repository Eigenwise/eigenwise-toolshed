# Scope

v1 became a brake one justified safety mechanism at a time. This file is how v2 avoids doing that again.

## The bar

A new gate, guard, check, hook, state or config key gets in only if both are true:

1. **There is an observed failure behind it.** A real incident in v2, with a link. Not a failure we can imagine, and not one v1 had for reasons v2 removed.
2. **It makes the developer faster.** Say the benefit in one line and the cost per ticket in one line. If the cost line is longer, the answer is no.

Anything that fails the bar gets a dated note in `.out-of-scope/` so the idea is not re-argued from scratch next month.

## The test for a ticket

Every ticket is judged against what a finished v2 does for a person: which part of that the ticket serves and what a person loses without it, then what it costs per ticket in time, tokens or stops for the person. A ticket that serves no part of it, only makes the machinery nicer for itself, or has a cost line longer than its benefit line is not built, and one line on the ticket says why. The same goes for what's already in the tree when a change touches it: a step, a check or a piece of text that slows the work with no benefit anyone can name gets cut.

## Design checklist

Before any mechanism ships:

- What does it do on the healthy path, and who trips it legitimately?
- Can the human always get past it with one action and a recorded reason?
- How many processes does it spawn per tool call? (The only right answer is zero.)
- How many tokens does the model read because of it while nothing is wrong? (Zero.)
- Does it work on a fresh solo install with no rules in the home directory?
- Is it per project and reversible?
- Is it a signal first? Blocking is something a person switches on later, per project.
- What does it delete? A change that only adds is suspect.

## Budgets

Round numbers with headroom. `scripts/budgets.mjs` prints the table. Only structural breaks fail a build.

| Thing | Budget |
| --- | --- |
| Processes spawned per tool call | 0 |
| Model-visible tokens per idle turn | 0 |
| Tools registered per plugin | 6 |
| A skill body | 1,100 words |
| An agent definition | 800 words |
| A plugin README | 1,500 words |
| Hard refusals in the whole marketplace | a handful, each naming the fact it saw and the next move, and only where answering would lose work or deliver the wrong thing. Bookkeeping (an unknown field, a missing outcome, a category with no route, a result nobody recorded) is repaired, and the answer says what was done. |

## Decision classes

- **What gets built.** The human's call, but only a choice that cannot be undone, spends money or reaches outside the project, or is taste or product direction; any other choice with a recommended answer is taken and reported. On work that goes through the `plan` skill and changes code, with a person here, the design a reviewer would argue about on the pull request is theirs too: the interface, where the behaviour lives, what is left out, the seam it is tested at. Asked after the agent has done the research, each question carrying a recommended answer.
- **How it gets done and shipped.** Never asked. No go-ahead questions, no commands handed to the human.
- **Changes to the system itself.** Always offered, approved per item, each one reversible.

## Standing refusals

See `.out-of-scope/`. The short list: no delivery state machine, no lifecycle writes from subagents, no shell-parsing guards, no process per tool call, no blocking Stop hooks, no proxy in the default routing path, no behaviour that depends on a rule in someone's home directory, no modes or intensity levels, no release train.
