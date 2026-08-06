# Starter atomic live-rule templates

These are lift-ready **individual rule files** for a new workspace. Use this catalog as reference while writing rules for **THIS project**. Derive each rule from the project's visible structure, stated purpose, existing conventions, and own guideline files. Do not pick blocks because they look close. A rule that lands byte-identical to a catalog block is evidence that it was copied rather than derived, so rewrite it in the project's terms before installing it.

Write each selected rule to its own `.claude/live-rules/rules/<stable-name>.md` file, with no shared header and exactly one frontmatter-plus-body rule per file. Ship the craft baseline on every workspace; add stack-specific rules only when the detected stack needs them. Keep bodies tight: all rules matching one event share a ~10k-character injection budget. Higher `priority` injects first.

**Installer requirement: generated rule text must conform to the target project's own voice and style rules. If the project's rules ban a construction, the generated rules cannot use that construction. Check the final text against the project's guidelines before writing any rule file.**

**Priority convention (standardized):** 90–100 = global craft baselines · 50–70 = stack/design rules ·
40–45 = prompt-keyword and self-improvement rules · 10 = narrow domain-file rules.

## Atomic directory and manifest

A new workspace uses `.claude/live-rules/`, never a new `.claude/live-rules.md`. Give every rule a
stable kebab-case file name derived from its heading, such as `atomic-commits.md` or
`svelte-5-components.md`. Then write `.claude/live-rules/manifest.json` from the UTF-8 contents of the
selected rule files with `\r` bytes removed. Do not hand-type hashes: SHA-256 each complete normalized
rule file, including its final newline, and copy scope metadata from its frontmatter. Every manifest entry
has this shape:

```json
{
  "version": 1,
  "rules": [
    {
      "path": "rules/atomic-commits.md",
      "hash": "<sha256 of the LF-normalized rules/atomic-commits.md contents>",
      "description": "Atomic commits & two hats",
      "globs": [],
      "dirs": [],
      "prompt": [],
      "priority": 95,
      "enabled": true,
      "include": []
    }
  ]
}
```

Write the complete directory through a temporary sibling, validate every hash against the files, then
rename it into `.claude/live-rules/`. The manifest's `path` values are relative to that directory.

---

## Craft baseline (global : ship on every workspace)

### Atomic commits & two hats

```markdown
---
description: Atomic commits & two hats
priority: 95
---
- One logical, self-contained change per commit; never bundle unrelated changes (a feature, a
  refactor, and a doc fix are three commits). Split by dependency order.
- Two hats: a commit either *adds behavior* (ships with its test) or *refactors*
  (behavior-preserving) : never both in one commit.
- Stage deliberately, per path or per hunk; never blind-add everything at once.
- Commit at each finished, green step. Commit only when asked; don't push unless asked. On the
  default branch, create a working branch first. Never amend published commits, never skip hooks.
```

### Commit messages state only what you verified

```markdown
---
description: Commit messages state only what you verified
priority: 87
---
- Every technical claim in a commit message must be something you actually observed or reproduced,
  not a plausible guess. An honest "cause not yet confirmed" beats an invented root cause.
- Describe what changed and why; don't narrate a fix you didn't verify.
```

### Simple design & small reversible steps (Beck / Fowler)

```markdown
---
description: Simple design & small reversible steps (Beck / Fowler)
priority: 90
---
Wear one hat at a time; small reversible steps, re-check between moves. Separate a behavior change
(pin with a test) from a refactor (behavior-preserving) : never fold tidy-up into a behavior change.
Beck's order: 1) passes tests, 2) reveals intention, 3) no duplication, 4) fewest elements (YAGNI).
Ties break toward clarity. Leave each file cleaner than you found it : as its own step.
```

### Surgical, simple, honest (Karpathy directive)

```markdown
---
description: Surgical, simple, honest
priority: 90
---
- Think before coding: state assumptions, surface ambiguity, push back on overcomplication. A wrong
  guess costs more than a question : ask instead of silently picking a reading.
- Simplicity first: the minimum code that solves it. No speculative abstractions, no "flexibility"
  nobody asked for, no error handling for impossible states.
- Surgical: every changed line traces to the request. Don't "improve" adjacent code or refactor what
  isn't broken; match the existing style. Remove only the dead code your change created.
- Define "done" and verify it before calling a change finished.
```

### Verify behavior, don't eyeball it

```markdown
---
description: Verify behavior deterministically
priority: 85
---
- Prove changes by exercising them : a script that asserts, a test, a real run whose output you show :
  not by eyeballing that it "looks right". Round-trip harnesses, diffs, exact-equality checks, counts.
- A change isn't "done" until a deterministic check passes and its output is shown.
```

### House code conventions (naming over comments)

```markdown
---
description: House code conventions
priority: 80
---
- No inline comments unless they capture a real hidden constraint (a *why* the code can't express).
  Lean on naming and structure, not narration. Delete commented-out code.
- Replace magic numbers with named constants. Match the surrounding code's idiom, naming, and
  comment density.
```

### Refactoring discipline (prompt-scoped)

```markdown
---
description: Refactoring discipline (Fowler)
prompt: ["refactor", "refactoring", "clean up", "cleanup", "tidy", "restructure"]
priority: 45
---
Refactoring changes structure, never behavior : and only starts from green (add a characterization
test first if needed). Name the smell, then apply the matching small named move (extract function,
rename, parameter object…), running tests after each. No behavior changes or features folded in :
separate commits. Many tiny safe moves beat one big rewrite.
```

### Optional: guidelines pointer (with the bundled digest)

Only if the user wants the deeper digest available. Copy `references/clean-code-principles.md` into
`.claude/` and add:

```markdown
---
description: Clean-code principles : read the guidelines file
priority: 5
---
- Before writing or refactoring non-trivial code, read `.claude/clean-code-principles.md` : a distilled
  clean-code digest (Martin, Fowler, Beck, Metz, Feathers).
- If you haven't read it this session, read it before your next code change, then apply it.
```

---

## Stack-specific rules (add the ones that match)

### Python + uv (single package)

```markdown
---
description: Python tooling : always use uv
globs: ["**/*.py", "**/pyproject.toml"]
priority: 60
---
- Run and manage Python only through uv: `uv run <script>`, `uv run python -c ...`, `uv add <pkg>`,
  `uv sync`. Never invoke bare `python`, `pip`, `pip install`, or `python -m venv`.
- Keep `uv run pytest` and `uv run ruff check .` green before calling a change done.
```

### Python + uv (workspace) : includes the bare-`uv sync` footgun

Use instead of the single-package rule when there's a `[tool.uv.workspace]` root with members.

```markdown
---
description: Python tooling : uv workspace
globs: ["**/*.py", "**/pyproject.toml"]
priority: 60
---
- Manage Python only through uv; never bare `python`/`pip`/`venv`.
- This is a uv workspace (virtual, non-packaged root; members under `packages/*`). Run `uv run ...`
  from the repo root; `uv run --package <name> <cmd>` targets one member.
- NEVER run a bare `uv sync` from the repo root : the virtual root has zero deps, so it PRUNES the
  whole shared `.venv`. Always `uv sync --all-packages`, or `uv sync --package <name>`. Same for
  `uv add`: use `uv add --package <name> <pkg>`, never a bare root `uv add`.
```

### Responsibility-driven Python design

```markdown
---
description: Responsibility-driven Python & API design (Metz / Wirfs-Brock / Bloch)
globs: ["**/*.py"]
priority: 50
---
- One clear responsibility per function/class, named for its role (not its data).
- Tell, don't ask; talk to friends, not strangers (Demeter). Guard clauses over deep nesting.
- Metz targets, justify any break: methods ~5 lines, classes ~100, ≤4 params.
- Isolate external deps (the network, the clock, RNG, heavy libs) behind small seams so core logic
  stays pure and testable. Validate at boundaries; prefer immutable value objects.
- Public API is a contract (Bloch): start private, widen only when needed. Log via a real logger,
  never `print()`.
```

### Python testing discipline

```markdown
---
description: Python testing discipline
globs: ["**/tests/**", "**/test_*.py", "**/*_test.py", "**/conftest.py"]
priority: 55
---
- Red → Green → Refactor. One behavior per test; Arrange-Act-Assert; name `test_<situation>_<expected>`.
- Add a characterization test before changing untested logic. Tests mirror the source tree.
```

### Svelte 5 components

```markdown
---
description: Svelte 5 components : runes, tokens, thin shell
globs: ["**/*.svelte"]
priority: 60
---
- Svelte 5 runes only: `$state`, `$derived`, `$props`, `$effect`; use `SvelteMap`/`SvelteSet` from
  `svelte/reactivity` for reactive collections.
- Style with scoped component styles + design tokens, not utility-class soup.
- Thin shell: keep logic in framework-free `.ts`; the component only wires UI to it.
- `$lib` is for code with 2+ consumers; route-private code colocates beside its `+page`.
```

### Pure-core boundary (framework-free domain layer)

```markdown
---
description: Pure core : no framework in the domain layer
globs: ["src/lib/<core>/**"]
priority: 55
---
- This is a pure leaf: no framework/DOM/env imports. Features depend on it, never the reverse.
- Fix bugs test-first with a colocated `*.test.ts`.
```

### RL / ML reproducibility (global)

```markdown
---
description: Reproducibility is non-negotiable
priority: 100
---
- Seed everything: Python `random`, numpy, the framework (`torch.manual_seed`/JAX key), AND the env
  (`env.reset(seed=...)`, space `.seed()`). A result you can't reproduce from a logged seed + config
  did not happen.
- Log the full config with every run (hyperparameters, env id+version, wrappers, git SHA, lib versions).
- Report over ≥3–5 seeds with dispersion, never one lucky run. Never tune on eval/test seeds (leakage).
```

### Ground in real framework behavior, not memory (fast-moving deps)

Generalizable to any project on fast-changing libraries.

```markdown
---
description: Verify framework behavior against docs, not memory
prompt: ["api", "version", "does <lib> support", "how does", "the docs"]
priority: 70
---
- For a library/framework/CLI whose behavior you're about to assert, verify against context7 (or the
  project's docs) before claiming an API works a certain way : training data lags releases.
- Record durable, verified facts in the codebase map so the next session doesn't re-check.
```

---

## Not-a-codebase (wiki / notes / content): first-class writing rules

Derive these rules from the target project's own guideline files, note types, folder taxonomy, and link conventions. Adapt globs and dirs to the actual project. Skip rules whose evidence is absent.

### Project voice and editorial shape

```markdown
---
description: Project voice and note shape
priority: 80
---
- Read the target project's own writing or editorial guidelines before drafting. Follow that voice, terminology, audience, and formatting; do not restate a generic house style here.
- Keep one durable idea per note or section. Preserve the project's expected note length, heading depth, and structure when neighboring notes show a pattern.
- When the project has different note types, use each type's documented shape instead of applying one format everywhere.
```

### Note-type frontmatter conformance

```markdown
---
description: Note-type frontmatter stays conformant
globs: ["**/*.md"]
priority: 65
---
- Match the frontmatter schema for the note's type: required fields, allowed values, date format, tags, aliases, and status.
- Copy field names and value shapes from the project's own examples or schema files. Do not invent a second spelling for an existing field.
- Before marking a note complete, validate its frontmatter against the closest note-type examples or the project's checker, when one exists.
```

### Temporal claims carry dates

```markdown
---
description: Date claims that will go stale
globs: ["**/*.md"]
priority: 55
---
- Date claims about people, projects, versions, policies, prices, availability, or current state with the claim's source date or a clear `last_verified` field.
- Prefer an explicit date over words such as "currently", "recently", or "soon". Add a review date when the claim needs periodic rechecking.
```

### Contradictory notes get reconciled

```markdown
---
description: Reconcile notes that disagree
globs: ["**/*.md"]
priority: 55
---
- When a new note contradicts an existing one, locate the older claim, compare their sources and dates, and decide whether one supersedes the other or both describe different conditions.
- Record the resolution in the note: link the related claim, state what changed, and preserve the older view when it remains useful. Do not silently overwrite a durable contradiction.
```

### Note provenance stays attached

```markdown
---
description: Keep note provenance traceable
globs: ["**/*.md"]
priority: 50
---
- For research, meeting, or imported notes, record where the material came from using the project's source, author, date, or capture fields.
- Keep a source link or reference beside the claim it supports. When a source is unavailable, label the gap and avoid presenting the claim as verified.
```

### Link hygiene and orphan handling

```markdown
---
description: Keep internal links healthy
globs: ["**/*.md"]
priority: 50
---
- Wikilinks and relative links resolve to an existing note or intended destination. Match the project's canonical link spelling and use aliases only when the project supports them.
- When renaming or moving a note, update inbound links or leave the project's supported redirect or alias. Fix dead links when found.
- Give new durable notes an intentional inbound link from the relevant index, map, or neighbor. Mark genuinely standalone notes as intentional or place them where the project's orphan policy says they belong.
```

## Research rigor rules

Research rules apply to research notes and to any note that makes a factual claim. Derive source locations, citation fields, and review cadence from the target project.

### Claims have traceable sources

```markdown
---
description: Research claims cite their sources
globs: ["**/research/**/*.md", "**/sources/**/*.md"]
priority: 70
---
- Attach a source to each material factual claim, using the project's citation format and source fields. A source link alone is not enough when the claim depends on a particular page, section, table, or timestamp.
- Label whether the source is primary evidence, a direct record, or a summary that reports someone else's evidence. Prefer the primary source when it is available, and say when the note relies on a summary.
```

### Uncertainty and staleness stay visible

```markdown
---
description: Mark uncertainty and research freshness
globs: ["**/research/**/*.md", "**/sources/**/*.md"]
priority: 65
---
- Preserve uncertainty in the note with the project's markers for confidence, open questions, disputed claims, or missing evidence. Do not smooth a qualified source into a definitive statement.
- Date the source, the claim, and the note's verification when any part can change. Add a review date or stale marker when the project has a freshness convention.
```

Adapt the bodies to the user's stated voice and structure from the interview. Install only rules that the project can justify from its own evidence.
