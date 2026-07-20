---
name: map-codebase
description: >-
  Generate a structured, self-maintaining codebase map: a set of atomic Markdown docs in
  .claude/.codebase-info/ that ground every future Claude session in how the project is built.
  Use when the user asks to "map the codebase", "document the codebase", "create codebase
  documentation", "generate architecture docs", "onboard me to this project", "what does this
  codebase do", "bootstrap codebase docs", "set up codebase-mapper", or "analyze the project
  structure". Works for any language/stack and for both existing projects and brand-new or empty
  ones. To refresh an existing map after code changes, use update-codebase-map instead.
---

# Map Codebase

Generate a codebase map as a collection of **atomic documents** in `.claude/.codebase-info/`. Each
document covers one aspect of the project, so the map stays easy to read, update, and navigate. The
map is written for the next Claude session (and the next human): it is grounding context, not
marketing.

Loading is automatic and you don't have to wire anything up: this plugin ships a `SessionStart`
hook that injects the map at the start of each session, so Claude starts oriented and keeps
consulting and updating it as work goes on. **Never edit `CLAUDE.md`.** The hook is the only loading
mechanism; leave `CLAUDE.md` alone. Your job is just to write the docs in `.claude/.codebase-info/`.

## Output

```
.claude/.codebase-info/
├── INDEX.md                # Navigation hub + how-to-use; the hook injects this at session start
├── architecture.md         # System overview, components, boundaries, data flow
├── tech-landscape.md       # Languages, frameworks, runtimes, infra, source-of-truth files
├── directory-structure.md  # Annotated folder tree
├── entry-points.md         # Where execution starts (routes, CLIs, jobs, main files)
├── modules.md              # Key modules/packages: purpose, deps, exports
├── communication.md        # APIs, events, queues, external integrations   (if applicable)
├── database.md             # Schema, relationships, migrations              (if applicable)
├── dependencies.md         # Categorized packages                           (if applicable)
├── patterns.md             # Recurring patterns, error handling, testing, config
├── coding-style.md         # Conventions derived from linters + existing code
├── docker.md               # Containers / local dev environment             (if applicable)
├── onboarding.md           # Quick start + common tasks
└── .map-state.json         # Machine state (last-mapped commit + date) for staleness checks
```

**This list is a menu, not a checklist.** Create only the documents that earn their place in *this*
codebase, and feel free to go beyond the list when a project has a major aspect the standard docs do
not cover. Two directions:

- **Omit what does not apply.** Skip `database.md` if there's no datastore, `docker.md` if there are
  no containers, `dependencies.md` if there's no dependency manifest, and so on. A tiny project might
  only need `INDEX.md`, `architecture.md`, `tech-landscape.md`, and `onboarding.md`.
- **Add what the project actually warrants.** If a major aspect deserves its own doc and none of the
  standard names fit, create one (e.g. `ml-pipeline.md` for a training/inference flow, `cli-reference.md`
  for a tool with many subcommands, `realtime.md` for a websocket/event core, `iac.md` for substantial
  infrastructure-as-code). List any such doc in `INDEX.md` and in the state file the same as the rest.

The test for every doc, standard or not, is the same: would a future session be meaningfully faster
for having it? If yes, write it; if not, leave it out.

## Process

### Step 0 — Assess project state (decide the path)

Get the lay of the land first, then pick a path:

- Count real source files, ignoring noise (`.git/`, `node_modules/`, `vendor/`, `dist/`, `build/`,
  `target/`, `.venv/`, `__pycache__/`, `.next/`, lockfiles, generated code, minified assets).
- Roughly size the project (file count, lines, number of top-level areas).

Then branch:

- **Existing project with real code → use the Sidequest handoff below when it is available.** Its
  artifact writer performs Steps 1–8; otherwise continue inline with Steps 1–8.
- **Greenfield (empty repo, scaffold only, or just a spec/README) → seed mapping inline.** Jump to the
  **Greenfield projects** section below, then do Step 8. Do not file a mapping ticket for this.
- **Large codebase (hundreds+ of source files) → use the large-repo story below when Sidequest is
  available.** Otherwise parallelize inline as described there, then complete Steps 7–8.

Also check today's actual date (it's provided in the session context, or run `date`) so the
"Last Updated" stamps are real, not placeholders.

### Sidequest handoff for an existing project

Inspect the session tool roster before doing mapping reads. The handoff is available only when the
normal native `Agent` tool and Sidequest's `category_list`, `add`, `comment`, `dispatch`, and `pulse`
tools are present. Do not probe the Sidequest CLI or dashboard. Read the live `codebase-exploration`
category with `category_list`; delegate only when it is enabled and its live contract permits one
bounded documentation-artifact write. The required contract language is that project source remains
read-only while a ticket may explicitly name one bounded documentation artifact directory as its only
write scope.

- When the tools are absent, continue inline without an error banner.
- When Sidequest is present but the category is missing, disabled, or still says `no edits`, continue
  inline and tell the user: `Sidequest is loaded, but its live taxonomy cannot accept map artifacts yet.`
- When the category is ready, create one artifact ticket for a small or medium initial map. Use category
  `codebase-exploration`, `files: [".claude/.codebase-info/"]`, and this exact carve-out:
  `Artifact write carve-out: write only .claude/.codebase-info/**; all project source is read-only.`

Record the starting `HEAD` (or `null` outside Git) and the initial working-tree status outside
`.claude/.codebase-info/` in the ticket. Its deliverable is warranted atomic docs, a compact linked
`INDEX.md`, and a final `.map-state.json` with exact document hashes. Tell the writer to inspect the
current shared tree; skip generated, vendor, and secret material; verify every cited path; never touch
`CLAUDE.md`; and never invoke `map-codebase` again or create nested mapping tickets. Include this
lifecycle marker verbatim:

```text
Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.
```

Before dispatch, post this reason as a ticket comment:

```text
Shared-tree dispatch is required because the map must describe the current working tree, including intentional uncommitted source, and the generated .claude/.codebase-info/** files must remain visible to the invoking session.
```

Dispatch with `{ sharedTree: true }`. Pass every returned spawn field to the native `Agent` unchanged.
Then end the turn and resume only on the native completion notification. Do not poll or start a proxy
waiter. Do not make concurrent project edits while the writer owns the shared tree.

On completion, read the ticket evidence and verify `INDEX.md`, changed paths, and state/hash consistency
without repeating the codebase reading. Run:

```text
node -e "const fs=require('node:fs'),c=require('node:crypto'),p='.claude/.codebase-info/',s=JSON.parse(fs.readFileSync(p+'.map-state.json','utf8'));if(!Array.isArray(s.documents))throw Error('documents');for(const n of new Set(['INDEX.md',...s.documents])){const b=fs.readFileSync(p+n);if(!s.hashes||s.hashes[n]!==c.createHash('sha256').update(b).digest('hex'))throw Error(n)}"
```

Require the writer's evidence to name cited-path checks, docs created/updated/removed, and confirmation
that `CLAUDE.md` is untouched. If source moved during mapping, the writer reconciles once or releases
rather than certifying a mixed snapshot.

For an add, dispatch, spawn, or executor failure, inspect `pulse` and the ticket thread first. Make at
most one diagnose-first redispatch, only when that diagnosis changes the launch and no live claim
remains. After a second failure, record the evidence on the ticket, make sure no writer owns the claim,
and complete the map inline in this same shared tree. Validate or repair any partial map before replacing
state, comment that the ticket completed through inline fallback, and give the user one short line naming
the delegation failure and inline fallback.

### Step 1 — Identify the stack

Read the project's manifest/config files to determine languages, frameworks, and tooling. See
`references/language-detection.md` for a broad map of signal files across ecosystems
(JS/TS, Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Swift, Elixir, C/C++, Dart/Flutter,
monorepos, and more). Note the framework(s) — they dictate where things live.

### Step 2 — Map the directory structure

List the tree (`git ls-files` in a git repo gives a clean, ignore-aware listing; otherwise `tree`
or a recursive list, skipping the noise dirs above). Identify the organizing principle:
- **Layer-based**: `controllers/`, `services/`, `models/`
- **Feature/domain-based**: `features/auth/`, `domains/billing/`
- **Hexagonal/clean**: `domain/`, `application/`, `infrastructure/`
- **Monorepo**: `packages/*`, `apps/*`, workspaces

### Step 3 — Find the entry points

Where does execution begin? Web routes, API routers, CLI command handlers, background workers/cron,
serverless handlers, library public exports, app `main`/bootstrap files, build/start scripts.

### Step 4 — Trace the key flows

For the 3–5 most important features, trace end to end: entry point → business logic → data layer →
external effects. Example: `POST /api/users` → `UserController.store()` → `UserService.create()` →
`users` table → `WelcomeEmail`. Note shared utilities and cross-cutting concerns (auth, logging,
validation, error handling).

### Step 5 — Catalog dependencies

From the manifest(s), categorize: **Core** (framework/runtime), **Data** (DB/ORM/cache),
**External** (API clients, third-party services), **Dev** (test/lint/build). Capture only what aids
understanding — don't transcribe the entire lockfile.

### Step 6 — Capture patterns & conventions

Recurring design patterns, error-handling approach, configuration/secrets management, logging and
observability, and testing structure. Derive coding style from linter/formatter configs
(`.eslintrc`, `ruff.toml`, `.editorconfig`, `rustfmt.toml`, etc.) **and** from what the code
actually does.

### Step 7 — Write the atomic documents

First decide the doc set: walk the aspects you found in Steps 1–6 and pick the documents this project
warrants (see "This list is a menu, not a checklist" above). Then create each one in
`.claude/.codebase-info/` using the templates in `references/document-templates.md`. For a
non-standard doc with no matching template, follow the same shape (title, `Last Updated` line, concrete
paths, tables/diagrams where they help). For each document:
- Put a real `*Last Updated: YYYY-MM-DD*` line under the title.
- Use concrete file paths (`src/auth/guard.ts`), not vague descriptions.
- Prefer tables for structured data (routes, modules, deps) and ASCII/Mermaid for architecture.
- Keep each doc self-contained but cross-link related docs.
- **Keep `INDEX.md` compact.** The hook injects it into context at the start of each session, so it should
  summarize the project in a few lines and link out to the detailed docs, which Claude reads on
  demand. Include the short "How to use / How to maintain this map" section from the template.

### Step 8 — Record state

Write `.claude/.codebase-info/.map-state.json` so `update-codebase-map` can detect staleness
precisely:

```json
{
  "tool": "codebase-mapper",
  "version": "2.1.0",
  "mappedAt": "YYYY-MM-DD",
  "gitCommit": "<full HEAD SHA, or null if not a git repo>",
  "documents": ["architecture.md", "tech-landscape.md", "..."],
  "hashes": {
    "INDEX.md": "<SHA-256 of the exact file contents>",
    "architecture.md": "<SHA-256 of the exact file contents>"
  }
}
```

Get the SHA with `git rev-parse HEAD` (use `null` if the project isn't a git repo). List exactly the
documents you created. Hash `INDEX.md` and every listed document from its exact final contents. Write
the documents and `.map-state.json` as one map update: stage the final document contents first, then
atomically replace the state file so a hook can only ever see either old hashes or a safely detectable
stale manifest.

Finally, tell the user the map is ready, remind them to **commit `.claude/.codebase-info/`** so their
team and every future session share it, and note that the plugin's hook will surface it
automatically from now on.

## Greenfield projects

A brand-new or empty project has little to map yet — so seed the map with *intent* and let it grow:

1. Look for any existing intent: `README`, a spec/PRD, design notes, issues, or scaffolding.
2. If intent isn't written down anywhere, ask the user 2–3 brief questions: What are you building?
   What's the intended stack? Any key architectural decisions already made?
3. Create a **lean** map: `INDEX.md`, `architecture.md` (goals + intended design), `tech-landscape.md`
   (chosen/intended stack), `directory-structure.md` (planned layout), and `onboarding.md`. Mark it
   clearly as a greenfield seed that will grow.
4. Do Step 8 (write state). From here, `update-codebase-map` fills in the rest as real code lands.

## Large codebases

For hundreds or thousands of source files, do not try to read everything serially:

- When the Sidequest preflight is ready, create one `codebase-exploration` story with read-only area
  tickets, then one final artifact-writer ticket depending on them. Area tickets report concise paths,
  symbols, entry points, and flows in their ticket threads. They do not write the map. The final writer
  reads those threads, reconciles them against the shared tree, and uses the same artifact scope,
  carve-out, lifecycle marker, shared-tree reason, and verification as an initial-map ticket. Do not
  create nested generic tasks.
- When Sidequest is unavailable, map the areas inline in the invoking session. Keep the same bounded
  pass over top-level structure and major flows rather than starting nested generic tasks.
- Favor breadth over exhaustive depth: capture each area's purpose, entry points, and key files rather
  than every file. The map is a guide, not a mirror.
- If you must sample rather than cover everything, say so in the relevant doc.

## Guidelines

- **Audience is a future Claude session.** Optimize for fast grounding and navigation.
- **Accuracy over completeness.** Every path and reference you write must exist. Don't invent.
- **Concrete, not abstract.** Real file paths, real command names, real table/route names.
- **Atomic + linked.** One concern per file; cross-reference rather than duplicate.
- **Never touch `CLAUDE.md`.** The plugin's hook handles loading. Do not add, edit, or remove
  anything in `CLAUDE.md` (or `CLAUDE.local.md`).
- **Respect ignore rules.** Never document `node_modules/`, `vendor/`, build output, or secrets.
- **Don't leak secrets.** Note that config exists and where, never actual credential values.

## Success criteria

- [ ] `.claude/.codebase-info/` created with `INDEX.md` + all applicable atomic docs
- [ ] `INDEX.md` is compact, links every created doc, and includes the how-to-use/maintain section
- [ ] Every doc has a real `Last Updated` date and verified file paths
- [ ] `.map-state.json` written with date, HEAD SHA (or null), and the document list
- [ ] `CLAUDE.md` left untouched
- [ ] User reminded to commit `.claude/.codebase-info/`

## References

- `references/document-templates.md` — templates for every document type
- `references/language-detection.md` — signal files for detecting stacks across ecosystems
