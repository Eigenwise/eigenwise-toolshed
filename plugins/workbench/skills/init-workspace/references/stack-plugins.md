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
project and team. For TypeScript projects, offer the official TypeScript LSP below.

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

Use `live-rules`, and offer `sidequest` if the user wants content tracking. Skip `codebase-mapper`,
language servers, and development plugins.

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
| TypeScript | `typescript-lsp@claude-plugins-official` | `typescript-language-server --version` | `npm install -g typescript-language-server typescript` |

A missing binary is a warning, not an automatic installer failure. The user can install it, continue
knowing the LSP cannot work until the binary exists, or drop the plugin. After reload, confirm the
binary is still on `PATH` and that the language server responds.

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

- **`$schema`** — `"https://json.schemastore.org/claude-code-settings.json"` for editor validation.
- **`hooks`** — project hooks the user already wants. `init-workspace` itself adds no project hooks.
- **`enableAllProjectMcpServers`** and **`enabledMcpjsonServers`** — only for project-owned MCP
  servers the user selected.

Keep `permissions` in `settings.local.json` (per-user and gitignored), not in the team-shared plan.
Merge these non-plugin settings only after the helper reports a successful install. Preserve existing
user values instead of replacing them.

## Scope

The plan defaults selected workspace plugins to project scope. Use local scope only when the user
explicitly asks for a personal install in this repository. Use user scope only when the user explicitly
requests a cross-project install and confirms it in the plan. Workbench itself remains user-scoped and
never appears in generated project settings.
