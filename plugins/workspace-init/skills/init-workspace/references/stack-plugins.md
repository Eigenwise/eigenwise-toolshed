# Stack → plugins catalog

Which plugins to enable in `.claude/settings.json`, keyed by stack. Lift the config blocks directly.
This catalog is a **starting point** — when you meet a stack it doesn't cover, add the right plugins
and then extend this file (that's a self-improvement move).

## The core (always)

`codebase-mapper` and `live-rules` on every workspace; `sidequest` unless the user opts out. Always
emit the toolshed `extraKnownMarketplaces` block so the marketplace resolves regardless of the user's
global state.

```json
{
  "enabledPlugins": {
    "codebase-mapper@eigenwise-toolshed": true,
    "live-rules@eigenwise-toolshed": true,
    "sidequest@eigenwise-toolshed": true
  },
  "extraKnownMarketplaces": {
    "eigenwise-toolshed": {
      "source": { "source": "github", "repo": "Eigenwise/eigenwise-toolshed" }
    }
  }
}
```

## The marketplace-source caveat (read before writing sources)

A plugin id is `name@marketplace`. To enable a plugin, the harness has to know that marketplace. Two
of them have **confirmed** github sources you can safely write:

| Marketplace | Source block |
|-------------|--------------|
| `eigenwise-toolshed` | `{ "source": "github", "repo": "Eigenwise/eigenwise-toolshed" }` |
| `cloudflare` | `{ "source": "github", "repo": "cloudflare/skills" }` |

`claude-plugins-official` is always known — it never needs an `extraKnownMarketplaces` entry.

The rest (`claude-ai-workshop`, `svelte`, `claude-code-lsps`, and any project-specific one) are
commonly registered at the **user's global level**, and their exact source repo isn't something to
guess. So when you want a plugin from one of those:

- Add it to `enabledPlugins` (harmless if the marketplace is already known globally), **but**
- **Don't invent an `extraKnownMarketplaces` source for it.** Instead tell the user: "I enabled
  `svelte@svelte`; if it doesn't resolve after reload, run `/plugin marketplace add <the svelte
  marketplace>` once." A wrong source block breaks resolution; a missing one just means the user adds
  the marketplace once by hand.

Rule of thumb: **write a source block only for `eigenwise-toolshed` and `cloudflare`.** For everything
else, enable and note.

## Near-universal add-on

- `context7@claude-plugins-official` — live, version-correct docs for libraries/frameworks/CLIs.
  Useful on almost any real project. Propose it by default.

## Frontend / web (Svelte, React, Vue, static sites)

```json
{
  "enabledPlugins": {
    "context7@claude-plugins-official": true,
    "frontend-design@claude-plugins-official": true,
    "vscode-langservers@claude-code-lsps": true,
    "playwright@claude-plugins-official": true,
    "security-guidance@claude-plugins-official": true
  }
}
```

- `svelte@svelte` — Svelte-specific (only for Svelte projects; source registered at user level).
- `better-frontend@claude-ai-workshop` — frontend build help (source at user level).
- `posthog@claude-plugins-official` — only if the project uses PostHog analytics.
- `vscode-langservers@claude-code-lsps` — HTML/CSS/JSON/TS langserver bundle (source at user level).
- `playwright@claude-plugins-official` — browser-driven testing/verification.

## Cloudflare-deployed

Add on top of the frontend set:

```json
{
  "enabledPlugins": { "cloudflare@cloudflare": true },
  "extraKnownMarketplaces": {
    "cloudflare": { "source": { "source": "github", "repo": "cloudflare/skills" } }
  }
}
```

## Python / ML / data

```json
{
  "enabledPlugins": {
    "context7@claude-plugins-official": true,
    "pyright-lsp@claude-plugins-official": true,
    "code-review@claude-plugins-official": true
  }
}
```

Python projects usually also want a `permissions.allow` block in `settings.local.json` for their
tooling (see "settings keys" below): `uv run/sync/add`, `ruff`, `ty`/`pyright`, `pytest`, plus read-only
git. ML projects often add `enableAllProjectMcpServers: true` and MCP servers like `deepwiki` for
framework docs.

## General / backend / library (no special stack)

Core three only, plus `context7` and a language server for the language in use
(`pyright-lsp` for Python, and so on). Don't pile on plugins a project won't use.

## Not-a-codebase (wiki, notes, docs, content)

`live-rules` (for writing-voice and structure rules) and optionally `sidequest` (to track content
work). **Skip `codebase-mapper`** — there's no code to map. Skip language servers and dev plugins.

## LSPs

Two mechanisms:

**(a) An official langserver plugin** — just enable it, no extra config:
`pyright-lsp@claude-plugins-official` (Python), `vscode-langservers@claude-code-lsps` (web bundle).

**(b) No official plugin exists → a local marketplace plugin declaring `lspServers`.** For a language
server with no ready plugin (e.g. Tailwind CSS), author a local marketplace under
`.claude/local-marketplace/` with a plugin whose `marketplace.json` entry carries an `lspServers` map:

```json
{
  "name": "tailwindcss-lsp",
  "version": "0.1.0",
  "source": "./tailwindcss-lsp",
  "lspServers": {
    "tailwindcss": {
      "command": "npx",
      "args": ["-y", "--package=@tailwindcss/language-server", "tailwindcss-language-server", "--stdio"],
      "transport": "stdio",
      "extensionToLanguage": { ".svelte": "svelte", ".html": "html", ".css": "css", ".ts": "typescript" },
      "startupTimeout": 60000,
      "maxRestarts": 3
    }
  }
}
```

On Windows, wrap the command as `"command": "cmd", "args": ["/c", "npx", ...]`. Only reach for a local
LSP when there's a real need; most projects are covered by (a). Don't set this up unprompted.

## Other `settings.json` keys worth knowing

- **`$schema`** — `"https://json.schemastore.org/claude-code-settings.json"` for `settings.json` gives
  editor validation. Optional but nice.
- **`permissions`** — usually in `settings.local.json` (per-user, gitignored), an `allow` array of
  `Bash(...)` / `PowerShell(...)` / `mcp__...` entries to cut permission prompts for a project's common
  commands. Consider seeding a small one for the detected tooling (or point the user at the
  `fewer-permission-prompts` skill).
- **`hooks`** — a project can register its own `SessionStart`/`UserPromptSubmit`/`Stop`/`PreToolUse`
  hooks here. workspace-init itself ships **no** hooks (the self-improvement loop is a live rule, not a
  hook), but a project may want its own later.
- **`enableAllProjectMcpServers`** (bool) and **`enabledMcpjsonServers`** (array, e.g. `["deepwiki"]`)
  — for projects that ship `.mcp.json` servers.

## `settings.json` vs `settings.local.json`

- `settings.json` — committed, team-shared. Put `enabledPlugins`, `extraKnownMarketplaces`, project
  hooks here.
- `settings.local.json` — gitignored, per-user. Put `permissions` and personal plugin toggles here so
  they don't force choices on teammates. (Make sure `.claude/settings.local.json` is gitignored.)
