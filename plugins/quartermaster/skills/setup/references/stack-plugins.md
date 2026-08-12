# Stack → installable plugin catalog

Use this catalog to build the Workbench bootstrap plan. It contains only plugins with a current,
reproducible marketplace source. The bootstrap helper installs plugins with `claude plugin install`;
do not copy these IDs into `enabledPlugins` yourself.

## Core

Select these for every codebase:

| Plugin | Marketplace source | Role |
|---|---|---|
| `codebase-mapper@eigenwise-toolshed` | `Eigenwise/eigenwise-toolshed` | Codebase map and injected index |
| `live-rules@eigenwise-toolshed` | `Eigenwise/eigenwise-toolshed` | Scoped, live workspace rules |
| `sidequest@eigenwise-toolshed` | `Eigenwise/eigenwise-toolshed` | Local work board and board-first orchestration loop: routes category-classified tickets to the right model and effort, then dispatches token-gated executors |

The helper installs the toolshed marketplace at project scope. Preserve its portable
`extraKnownMarketplaces` declaration only when the plugin CLI did not already make it visible in
`.claude/settings.json`:

```json
{
  "eigenwise-toolshed": {
    "source": { "source": "github", "repo": "Eigenwise/eigenwise-toolshed" }
  }
}
```

## Official marketplace

`claude-plugins-official` is available automatically. Do not add an
`extraKnownMarketplaces` entry for it. If Claude Code reports it missing, add
`anthropics/claude-plugins-official`, then retry the failed install.

Propose these only when they fit the project:

| Plugin | Best fit |
|---|---|
| `context7@claude-plugins-official` | Live, version-correct library and framework docs |
| `frontend-design@claude-plugins-official` | Frontend or web UI work |
| `playwright@claude-plugins-official` | Browser-driven verification |
| `security-guidance@claude-plugins-official` | Projects where automatic code-change security review is wanted |
| `code-review@claude-plugins-official` | Projects that want the official review workflow |

## Stack extras

### Frontend / web

Propose `context7`, `frontend-design`, `playwright`, and `security-guidance` when they match the
project and team. TypeScript and JavaScript code intelligence is already covered: Workbench ships
pull-only tools for it (see the TypeScript note under the LSP table), so never propose
`typescript-lsp@claude-plugins-official`.

### Cloudflare-deployed

Add `cloudflare@cloudflare` only for a Cloudflare project. Its portable marketplace source is:

```json
{
  "cloudflare": {
    "source": { "source": "github", "repo": "cloudflare/skills" }
  }
}
```

### Svelte

Add `svelte@svelte` only for a Svelte project. Its portable marketplace source is:

```json
{
  "svelte": {
    "source": { "source": "github", "repo": "sveltejs/ai-tools" }
  }
}
```

### Python / ML / data

Propose `context7`, `pyright-lsp`, and optionally `code-review`. ML projects may also choose
`enableAllProjectMcpServers: true` or named `.mcp.json` servers as non-plugin settings when those
servers are already part of the project.

### Backend / library

Start with the core and `context7`; offer the relevant official LSP from the table below. Do not add
plugins merely because a stack is technically present.

### Not a codebase

A not-a-codebase project is a first-class setup path, not a leftover bucket for projects that
failed stack detection. Treat its files, recurring work, and information structure as the stack. Start
with `live-rules` and `sidequest`, then choose the rest from the project's actual shape.

#### Obsidian vault

Look for `.obsidian/`, `[[wikilinks]]`, and Templater-style frontmatter or templates. Use `live-rules`
for note voice, frontmatter, and link rules, and `sidequest` when the vault has recurring research or
writing work to track. Skip `codebase-mapper` for a pure vault because there is no code architecture
to map. Skip language servers and development plugins unless maintenance scripts are a meaningful,
separately scoped part of the work. The workspace should produce note-type guidance, a map of the
vault's folder and link conventions, and rules for keeping templates and indexes consistent.

#### Docs site

Look for Astro or Starlight config, `mkdocs.yml`, `docusaurus.config.*`, a docs build, or a content
source tree with package or CI files. Use `live-rules` for prose, frontmatter, links, and release
checks, and `sidequest` for planned documentation work. A docs site with a build is a codebase, so
use `codebase-mapper` and the matching code or frontend plugins when its source warrants them. The
workspace should produce a codebase map plus a docs information map covering content types, navigation,
build commands, and published output.

#### Wiki or note collection

Look for Markdown or plain-text notes arranged by topic, without an application build or a strict
publishing pipeline. Use `live-rules` for note structure, links, source quality, and terminology, and
`sidequest` for editorial or research queues. Skip `codebase-mapper` because a pure collection has no
software architecture, and skip language servers and development plugins. The workspace should produce
an index of topic and note conventions, note-type templates where useful, and maintenance rules for
links, references, and conflicting claims.

#### Content repo

Look for articles, posts, media metadata, editorial folders, publishing scripts, or a CMS export. Use
`live-rules` for voice, frontmatter, review status, and publication checks, and `sidequest` for the
editorial backlog. Use `codebase-mapper` only when the repo has a real build or application layer; a
content-only repo does not need it. The workspace should produce a content taxonomy, publishing and
review workflow notes, and rules for assets, dates, links, and generated files.

#### Research corpus

Look for source PDFs or scans, datasets, citations, bibliographies, lab notes, or a folder structure
organized around questions and evidence. Use `live-rules` for citation, uncertainty, provenance, and
note conventions, and `sidequest` for research queues and synthesis work. Skip `codebase-mapper` for a
pure corpus, and skip development plugins unless a real software component needs them. The workspace
should produce a source and evidence index, research-note structure, and rules for dating claims,
recording uncertainty, and linking conclusions back to primary material.

#### Maintenance scripts

A vault, content repo, or research corpus may still contain Python or shell maintenance scripts. Treat
those scripts as real code inside a not-a-codebase project. A coding-capable category and stack rules
are justified when the scripts are recurring work, but scope them to the script paths and their tests.
Do not turn the whole project into a code project or add a full language stack just because one helper
exists. Keep the main workspace shape focused on notes, content, or evidence, then add the script
commands, dependencies, and maintenance checks that people actually run.

## Official LSP plugins and binary preflight

Each official LSP plugin needs its language-server executable on `PATH`. Add the matching
`preflight` entry to the bootstrap plan, run its check before installation, and only report the hint.
Never install system packages or run a package manager for the user.

| Language | Plugin ID | Check | Install hint |
|---|---|---|---|
| C/C++ | `clangd-lsp@claude-plugins-official` | `clangd --version` | Install `clangd` with the platform package manager |
| C# | `csharp-lsp@claude-plugins-official` | `csharp-ls --version` | `dotnet tool install --global csharp-ls` |
| Go | `gopls-lsp@claude-plugins-official` | `gopls version` | `go install golang.org/x/tools/gopls@latest` |
| Java | `jdtls-lsp@claude-plugins-official` | `jdtls --version` | Install `jdtls` with the platform package manager |
| Kotlin | `kotlin-lsp@claude-plugins-official` | `kotlin-language-server --version` | Install `kotlin-language-server` with the platform package manager |
| Lua | `lua-lsp@claude-plugins-official` | `lua-language-server --version` | Install `lua-language-server` with the platform package manager |
| PHP | `php-lsp@claude-plugins-official` | `intelephense --version` | `npm install -g intelephense` |
| Python | `pyright-lsp@claude-plugins-official` | `pyright-langserver --version` | `npm install -g pyright` |
| Ruby | `ruby-lsp@claude-plugins-official` | `ruby --version` (3.0+) | `gem install ruby-lsp` |
| Rust | `rust-analyzer-lsp@claude-plugins-official` | `rust-analyzer --version` | `rustup component add rust-analyzer` |
| Swift | `swift-lsp@claude-plugins-official` | `sourcekit-lsp --version` | Install the Swift toolchain for the platform |

A missing binary is a warning, not an automatic installer failure. The user can install it, continue
knowing the LSP cannot work until the binary exists, or drop the plugin. After reload, confirm the
binary is still on `PATH` and that the language server responds.

TypeScript is deliberately absent from this table. Workbench itself serves TypeScript/JavaScript code
intelligence through its pull-only `code-intel` MCP tools (`definition`, `references`, `diagnostics`),
which pick a language server from the requested file's extension and talk to the project's own
TypeScript install.

Workbench also serves C and C++ through `clangd`, so do not propose `clangd-lsp@claude-plugins-official` for a CMake project. Before its code-intel tools can answer, the project must provide a current `compile_commands.json` that covers the queried translation unit. Workbench never runs a build to produce one, and never guesses a preset, generator, or toolchain: read the project's own configure step and tell the user to add `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` to it, or `CMAKE_EXPORT_COMPILE_COMMANDS` to the preset's `cacheVariables`. Then record two settings so refusals stay actionable: `WORKBENCH_CODE_INTEL_CPP_COMPILE_COMMANDS` when the database is not at the project root, and `WORKBENCH_CODE_INTEL_CPP_REGENERATE_COMMAND` set to that project's real configure command. Workbench refuses a missing or stale database rather than returning wrong answers.
Do not install `typescript-lsp@claude-plugins-official`: its push diagnostics are process-global and
blind to which agent owns them, so diagnostics from parallel isolated worktrees leak into the wrong
transcript. If it is already installed, recommend removing it with
`/plugin uninstall typescript-lsp@claude-plugins-official`. Preflight for a TypeScript project instead:
TypeScript 7 resolvable in the project (`npm install -D typescript@latest`), or
`typescript-language-server --version` for TypeScript 5 projects.

## Portable marketplace sources

Use only these sources in bootstrap plans. They are reproducible and safe to write for collaborators:

| Marketplace | Source |
|---|---|
| `eigenwise-toolshed` | `Eigenwise/eigenwise-toolshed` |
| `cloudflare` | `cloudflare/skills` |
| `svelte` | `sveltejs/ai-tools` |
| `claude-community` | `anthropics/claude-plugins-community` |
| `claude-plugins-official` | Automatically available; no source declaration |

Do not recommend a plugin whose marketplace source is unavailable to the bootstrap helper. Do not
create an ad hoc local marketplace during workspace initialization.

## Non-plugin settings

The plan's `settingsMerge` can carry settings that the plugin CLI does not own:

- **`$schema`**: `"https://json.schemastore.org/claude-code-settings.json"` for editor validation.
- **`hooks`**: project hooks the user already wants. the quartermaster setup skill itself adds no project hooks.
- **`enableAllProjectMcpServers`** and **`enabledMcpjsonServers`**: only for project-owned MCP
  servers the user selected.

Keep `permissions` in `settings.local.json` (per-user and gitignored), not in the team-shared plan.
Merge these non-plugin settings only after the helper reports a successful install. Preserve existing
user values instead of replacing them.

## Scope

The plan defaults selected workspace plugins to project scope. Use local scope only when the user
explicitly asks for a personal install in this repository. Use user scope only when the user explicitly
requests a cross-project install and confirms it in the plan. Workbench itself remains user-scoped and
never appears in generated project settings.
