# Starter atomic live-rule templates

These are lift-ready **individual rule files** for a new workspace. Write each selected block to its
own `.claude/live-rules/rules/<stable-name>.md` file, with no shared header and exactly one
frontmatter-plus-body rule per file. Ship the **craft baseline** on every workspace; add the
**stack-specific** ones that match the detected stack. Keep bodies tight: all rules matching one
event share a ~10k-character injection budget. Higher `priority` injects first.

**Priority convention (standardized):** 90–100 = global craft baselines · 50–70 = stack/design rules ·
40–45 = prompt-keyword and self-improvement rules · 10 = narrow domain-file rules.

## Atomic directory and manifest

A new workspace uses `.claude/live-rules/`, never a new `.claude/live-rules.md`. Give every rule a
stable kebab-case file name derived from its heading, such as `atomic-commits.md` or
`svelte-5-components.md`. Then write `.claude/live-rules/manifest.json` from the exact UTF-8 contents
of the selected rule files. Do not hand-type hashes: SHA-256 each complete rule file, including its
final newline, and copy scope metadata from its frontmatter. Every manifest entry has this shape:

```json
{
  "version": 1,
  "rules": [
    {
      "path": "rules/atomic-commits.md",
      "hash": "<sha256 of the exact rules/atomic-commits.md contents>",
      "description": "Atomic commits & two hats",
      "globs": [],
      "dirs": [],
      "prompt": [],
      "enabled": true
    }
  ]
}
```

Write the complete directory through a temporary sibling, validate every hash against the files, then
rename it into `.claude/live-rules/`. The manifest's `path` values are relative to that directory.

---

## Craft baseline (global — ship on every workspace)

### Atomic commits & two hats

```markdown
---
description: Atomic commits & two hats
priority: 95
---
- One logical, self-contained change per commit; never bundle unrelated changes (a feature, a
  refactor, and a doc fix are three commits). Split by dependency order.
- Two hats: a commit either *adds behavior* (ships with its test) or *refactors*
  (behavior-preserving) — never both in one commit.
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
(pin with a test) from a refactor (behavior-preserving) — never fold tidy-up into a behavior change.
Beck's order: 1) passes tests, 2) reveals intention, 3) no duplication, 4) fewest elements (YAGNI).
Ties break toward clarity. Leave each file cleaner than you found it — as its own step.
```

### Surgical, simple, honest (Karpathy directive)

```markdown
---
description: Surgical, simple, honest
priority: 90
---
- Think before coding: state assumptions, surface ambiguity, push back on overcomplication. A wrong
  guess costs more than a question — ask instead of silently picking a reading.
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
- Prove changes by exercising them — a script that asserts, a test, a real run whose output you show —
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
Refactoring changes structure, never behavior — and only starts from green (add a characterization
test first if needed). Name the smell, then apply the matching small named move (extract function,
rename, parameter object…), running tests after each. No behavior changes or features folded in —
separate commits. Many tiny safe moves beat one big rewrite.
```

### Optional: guidelines pointer (with the bundled digest)

Only if the user wants the deeper digest available. Copy `references/clean-code-principles.md` into
`.claude/` and add:

```markdown
---
description: Clean-code principles — read the guidelines file
priority: 5
---
- Before writing or refactoring non-trivial code, read `.claude/clean-code-principles.md` — a distilled
  clean-code digest (Martin, Fowler, Beck, Metz, Feathers).
- If you haven't read it this session, read it before your next code change, then apply it.
```

---

## Stack-specific rules (add the ones that match)

### Python + uv (single package)

```markdown
---
description: Python tooling — always use uv
globs: ["**/*.py", "**/pyproject.toml"]
priority: 60
---
- Run and manage Python only through uv: `uv run <script>`, `uv run python -c ...`, `uv add <pkg>`,
  `uv sync`. Never invoke bare `python`, `pip`, `pip install`, or `python -m venv`.
- Keep `uv run pytest` and `uv run ruff check .` green before calling a change done.
```

### Python + uv (workspace) — includes the bare-`uv sync` footgun

Use instead of the single-package rule when there's a `[tool.uv.workspace]` root with members.

```markdown
---
description: Python tooling — uv workspace
globs: ["**/*.py", "**/pyproject.toml"]
priority: 60
---
- Manage Python only through uv; never bare `python`/`pip`/`venv`.
- This is a uv workspace (virtual, non-packaged root; members under `packages/*`). Run `uv run ...`
  from the repo root; `uv run --package <name> <cmd>` targets one member.
- NEVER run a bare `uv sync` from the repo root — the virtual root has zero deps, so it PRUNES the
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
description: Svelte 5 components — runes, tokens, thin shell
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
description: Pure core — no framework in the domain layer
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
  project's docs) before claiming an API works a certain way — training data lags releases.
- Record durable, verified facts in the codebase map so the next session doesn't re-check.
```

---

## Not-a-codebase (wiki / notes / content) — writing rules

```markdown
---
description: Writing voice & structure
priority: 80
---
- <the project's voice: plain, specific, whatever the user described>. One idea per note/section.
- Link related notes rather than duplicating; keep each note atomic and self-contained.
- Match the existing structure and front-matter conventions of neighboring files.
```

Adapt the body to the user's stated voice and structure from the interview. Skip all the code rules.
