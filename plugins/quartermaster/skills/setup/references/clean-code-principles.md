# Clean Code Principles

Working principles distilled from five practitioners. Apply them when writing, reviewing, or
refactoring code. They are guidance, not dogma : break one when you can articulate why, the way Sandi
Metz lets you break a rule if you can talk your pair into it.

House convention first: **no inline comments unless they capture a real hidden constraint** (a *why*
the code itself cannot express). Lean on naming and structure, not narration.

> This is the optional digest bundled with the quartermaster setup skill. Copy it into a project's `.claude/` only
> when the user wants the "guidelines pointer" live rule (see `rule-templates.md`). It's stack-agnostic.

---

## Robert C. Martin (Uncle Bob) : *Clean Code*

- **Names reveal intent.** Prefer names and direct structure over explanatory comments.
- **Change for a reason.** Extract only when it clarifies observed behavior or removes observed
  duplication; do not use line counts as a design target.
- **Comments are a last resort.** Delete comments that restate the code; keep only ones that record
  a hidden constraint or *why*.

## Martin Fowler : *Refactoring*

- **Write for the next human.** "Any fool can write code that a computer can understand. Good
  programmers write code that humans can understand."
- **Keep behavior clear.** When code needs to change, use the smallest shared-root change that
  preserves the requested behavior; refactor only when the observed shape blocks that change.
- **Name the reason, then make the smallest move.** Use a focused regression check for the behavior
  you touched.

## Kent Beck : XP / *Simple Design*

- **Make it work, make it right, make it fast** : in that order. Don't optimize before it's correct.
- **Four rules of simple design**, in priority order:
  1. Passes the tests.
  2. Reveals intention.
  3. No duplication (say everything once and only once).
  4. Fewest elements (no needless classes/methods).
- **YAGNI** : "You aren't gonna need it." Build for today's requirement, not an imagined future.

## Sandi Metz : *POODR*

- **Prefer duplication over the wrong abstraction.** Reuse an existing code path where it fits;
  otherwise wait for an observed pattern before extracting one.
- **Keep the needed shape.** A function, class, or parameter list needs no arbitrary size target.
- **Use boundaries that already exist.** Add an abstraction only when a real external or trust boundary
  needs one. Validate at trust boundaries and protect data-loss paths.

## Michael Feathers : *Working Effectively with Legacy Code*

- **Code without tests is legacy code.** It doesn't matter how well written it is : without tests you
  can't know whether a change made it better or worse.
- **Preserve what matters.** Add a characterization test when it is the smallest reliable way to
  establish unfamiliar behavior before changing it.
- **Focused, verified steps.** Exercise the changed behavior with the smallest reliable check; one
  integration owner runs the full gate after merged changes.

---

## Sources

- Robert C. Martin, *Clean Code* (2008).
- Martin Fowler, *Refactoring* (2nd ed., 2018); [Beck Design Rules](https://martinfowler.com/bliki/BeckDesignRules.html).
- Kent Beck : [Four rules of simple design](https://martinfowler.com/bliki/BeckDesignRules.html).
- Sandi Metz : [Rules for Developers](https://thoughtbot.com/blog/sandi-metz-rules-for-developers); *POODR*.
- Michael Feathers : *Working Effectively with Legacy Code*; [what "legacy code" means](https://understandlegacycode.com/blog/what-is-legacy-code-is-it-code-without-tests/).
