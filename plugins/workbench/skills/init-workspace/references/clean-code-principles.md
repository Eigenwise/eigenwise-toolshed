# Clean Code Principles

Working principles distilled from five practitioners. Apply them when writing, reviewing, or
refactoring code. They are guidance, not dogma — break one when you can articulate why, the way Sandi
Metz lets you break a rule if you can talk your pair into it.

House convention first: **no inline comments unless they capture a real hidden constraint** (a *why*
the code itself cannot express). Lean on naming and structure, not narration.

> This is the optional digest bundled with `init-workspace`. Copy it into a project's `.claude/` only
> when the user wants the "guidelines pointer" live rule (see `rule-templates.md`). It's stack-agnostic.

---

## Robert C. Martin (Uncle Bob) — *Clean Code*

- **Names reveal intent.** A good name removes the need for a comment. Rename until the code reads
  like the thing it does.
- **Functions do one thing.** Keep them small and at a single level of abstraction; extract until each
  function has one reason to exist.
- **Comments are a last resort.** A comment is an apology for code that failed to explain itself.
  Delete comments that restate the code; keep only the ones that record a real constraint or *why*.
- **Boy Scout Rule.** Leave every file a little cleaner than you found it.

## Martin Fowler — *Refactoring*

- **Write for the next human.** "Any fool can write code that a computer can understand. Good
  programmers write code that humans can understand."
- **Refactor first, then change.** "When you have to add a feature to a program and the code is not
  structured conveniently, first refactor the program to make it easy to add the feature, then add it."
- **Name the smell, then fix it in small steps.** Identify the code smell (duplication, long function,
  feature envy, primitive obsession...) and remove it with small, behavior-preserving refactorings —
  ideally with tests green between each step.

## Kent Beck — XP / *Simple Design*

- **Make it work, make it right, make it fast** — in that order. Don't optimize before it's correct.
- **Four rules of simple design**, in priority order:
  1. Passes the tests.
  2. Reveals intention.
  3. No duplication (say everything once and only once).
  4. Fewest elements (no needless classes/methods).
- **YAGNI** — "You aren't gonna need it." Build for today's requirement, not an imagined future.

## Sandi Metz — *POODR*

- **Prefer duplication over the wrong abstraction.** "Duplication is far cheaper than the wrong
  abstraction." Wait until the pattern is obvious before extracting it.
- **Keep units small.** Short classes, short methods, few parameters. When a method grows, extract a
  well-named private method — private methods are great documentation.
- **Depend on abstractions, not concretions.** Talk to objects through roles/messages and inject
  collaborators, so behavior is swappable and testable.

## Michael Feathers — *Working Effectively with Legacy Code*

- **Code without tests is legacy code.** It doesn't matter how well written it is — without tests you
  can't know whether a change made it better or worse.
- **Characterize before you change.** Before altering unfamiliar code, pin its current behavior with a
  characterization test, then find a *seam* (a place to alter behavior without editing in place) to
  work at.
- **Small, verified steps.** Change a little, run the tests, repeat — so you always know where you
  stand.

---

## Sources

- Robert C. Martin, *Clean Code* (2008).
- Martin Fowler, *Refactoring* (2nd ed., 2018); [Beck Design Rules](https://martinfowler.com/bliki/BeckDesignRules.html).
- Kent Beck — [Four rules of simple design](https://martinfowler.com/bliki/BeckDesignRules.html).
- Sandi Metz — [Rules for Developers](https://thoughtbot.com/blog/sandi-metz-rules-for-developers); *POODR*.
- Michael Feathers — *Working Effectively with Legacy Code*; [what "legacy code" means](https://understandlegacycode.com/blog/what-is-legacy-code-is-it-code-without-tests/).
