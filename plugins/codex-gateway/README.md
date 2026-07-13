# codex-gateway

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fcodex-gateway%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Eigenwise)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/eigenwise)
[![Discord](https://img.shields.io/badge/chat-on_discord-7289DA?logo=discord&logoColor=white)](https://discord.gg/J3W9b5AZJR)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

**Your ChatGPT/Codex subscription models, in Claude Code's `/model` picker.** Open `/model`, see
"GPT-5.6-sol (Codex)" next to your Anthropic models, and switch mid-session. Codex requests are
billed to your ChatGPT Plus/Pro plan through OpenAI's own OAuth (no API key); Claude requests
keep flowing to api.anthropic.com with your normal claude.ai login. Both subscriptions, one
harness.

## How it works

```
Claude Code ── ANTHROPIC_BASE_URL ──▶ shim (127.0.0.1:18764)
                                        │
                     model claude-codex-* ──▶ claude-code-proxy (:18765) ──▶ Codex backend
                     everything else ───────▶ api.anthropic.com (untouched passthrough)
```

- [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) does the hard part:
  ChatGPT OAuth (PKCE) and translating the Anthropic Messages API to OpenAI's Codex backend.
  It's actively maintained, which matters because OpenAI periodically tightens how it
  fingerprints Codex clients.
- The **shim** (this plugin, one dependency-free node file) is what gets you the picker.
  Claude Code's [gateway model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery)
  can populate `/model` from a gateway's `/v1/models`, but it drops ids that don't start with
  `claude` or `anthropic`. So the shim advertises the proxy's models as `claude-codex-<id>`
  with readable display names, strips the prefix on the way through, and passes every
  non-Codex request to api.anthropic.com byte-for-byte (your claude.ai auth, prompt caching,
  and beta headers are untouched).
- A **SessionStart hook** keeps both processes alive so a wired session never starts against a
  dead port.
- codex-gateway also publishes a small model catalog (`catalog.json`, next to its state) carrying the
  GPT-5.6 family (Sol, Terra, Luna) that [sidequest](../sidequest) reads to offer as routing-tier
  backends. The `/model` picker above still sees every model; the catalog is a separate, narrower
  surface just for sidequest's tier mapping.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codex-gateway@eigenwise-toolshed
```

**Install it at user scope** (that's the default for `/plugin install`). codex-gateway wires a
global env var (`ANTHROPIC_BASE_URL`, so every session everywhere routes through the shim) and its
keepalive hook has to run in every project. A project-only or local install leaves your other
projects pointing at a shim that nothing keeps alive there, so requests in those projects fail.
`doctor` warns you if it finds a project-only install; reinstall with
`claude plugin install codex-gateway@eigenwise-toolshed --scope user`.

On your next session, Claude notices the plugin isn't set up yet (a one-line SessionStart nudge)
and offers to finish the job. Say yes. `setup` is one command: it downloads claude-code-proxy
(sha256-verified), starts the gateway, and wires your settings; the only thing it can't do for
you is the ChatGPT browser sign-in, which it asks for when needed. Then restart Claude Code and
open `/model`: the Codex rows are there, labeled "From gateway".

Prefer doing it by hand? Same thing:

```bash
node <plugin>/bin/codex-gateway.js setup   # download + start + wire; prompts for login if needed
node <plugin>/bin/codex-gateway.js login   # ChatGPT sign-in in your browser (if asked)
node <plugin>/bin/codex-gateway.js setup   # finishes the wiring after sign-in
```

Model discovery needs Claude Code v2.1.129+. Re-running `setup` later is also how you upgrade
the proxy.

## Commands

| Command | What it does |
|---|---|
| `setup` | Download the latest claude-code-proxy release for your platform, verify sha256 |
| `login [--device]` | ChatGPT OAuth; `--device` prints a device code for headless boxes |
| `start` / `stop` / `status` | Manage the proxy + shim (detached; logs in `~/.claude/codex-gateway/logs/`) |
| `ensure [--quiet]` | Start whatever's down; the SessionStart hook runs this |
| `models` | Show exactly what the shim advertises to the picker |
| `catalog [--json]` | Print the sidequest-readable model catalog (recomputed if stale/missing) |
| `env [--write-user\|--write-project\|--remove]` | Print or wire/unwire the Claude Code env block |
| `doctor` | Binary, auth, ports, model count, settings wiring, in one shot |
| `remote-control enable\|disable\|doctor` | Confirmation-gated hosts compatibility workflow, or read-only diagnosis |

### Trace unexpected model usage

Set `CODEX_GATEWAY_REQUEST_LOG=1` before starting the shim. It appends one JSON object per routed
request to `~/.claude/codex-gateway/logs/request-routes.jsonl`: timestamp, route (`codex` or
`anthropic`), requested model, request path, and Claude Code's session id when supplied. It never
writes request bodies, prompts, tool payloads, authorization, or arbitrary headers. Set
`CODEX_GATEWAY_REQUEST_LOG_PATH` to put this metadata-only log somewhere else.

```text
{"at":"...","backend":"anthropic","model":"claude-fable-5","path":"/v1/messages","sessionId":"..."}
```

After changing either variable, restart the gateway (`stop`, then `start`) so its detached shim gets
the new environment.

## RC-compatibility mode (restoring `/remote-control`)

Claude Code's built-in `/remote-control` only lights up when `ANTHROPIC_BASE_URL` is exactly the
real Anthropic host. There's no supported way to keep Codex routing *and* get that exact host at
the same time without touching the OS — no hosts-file changes, custom CA, admin rights, or Claude
binary patching is possible for both features simultaneously. So it's opt-in, detected, and
completely reversible:

1. Run `node <plugin>/bin/codex-gateway.js remote-control doctor` first. It is read-only and
   reports partial blocks, conflicting mappings, elevation needs, port conflicts, stale settings,
   and recovery failures.
2. **You** (never this plugin) can add one marker-delimited block to your hosts file, mapping
   `api.anthropic.com` to loopback. The `remote-control-compatibility` skill explains the exact
   edit, asks for direct user confirmation, backs up the file, then runs
   `remote-control enable --confirm` only after that answer:

   | OS | Hosts file | Managed line |
   |---|---|---|
   | Windows | `C:\Windows\System32\drivers\etc\hosts` (edit as Administrator) | `127.0.0.1 api.anthropic.com` |
   | macOS | `/etc/hosts` (edit with `sudo`) | `127.0.0.1 api.anthropic.com` |
   | Linux | `/etc/hosts` (edit with `sudo`) | `127.0.0.1 api.anthropic.com` |

   The match has to be exact: a loopback address (`127.0.0.1` or `::1`) and the literal hostname
   `api.anthropic.com` (other aliases on the same line are fine; comments after `#` are ignored).
   The plugin writes only its own marked block and preserves all unrelated hosts content.
3. On the next `ensure` (the SessionStart hook, or `setup`/`doctor`), codex-gateway detects the
   entry, confirms it can actually bind loopback **port 80**, and — only if both hold — switches
   the plugin-owned `ANTHROPIC_BASE_URL` to `http://api.anthropic.com` and starts a second listener
   on that port next to the usual `127.0.0.1:18764`. Nothing else in your settings changes. You get
   exactly one line telling you to restart Claude Code.
4. Restart Claude Code. `/model` still shows the Codex rows, and `/remote-control` is now available,
   because Claude Code sees the real Anthropic host.
5. Run `remote-control disable --confirm` after another direct confirmation to remove only the
   plugin-marked block, restore default mode, and verify it. If you manually remove the hosts block,
   the next `ensure` also reverts the gateway automatically.

Notes:
- Port 80 needs no special privilege on Windows, but Linux and macOS reserve ports below 1024 for
  root; without `sudo`/`CAP_NET_BIND_SERVICE` the bind fails and codex-gateway just stays in
  default mode (`doctor` shows why).
- The shim avoids routing back into itself: real (non-Codex) requests still need to reach the
  actual Anthropic servers, so when the hosts entry is active the shim resolves `api.anthropic.com`
  with a direct DNS query (which, unlike the OS resolver, never consults the hosts file) instead of
  the poisoned address your hosts file hands to everything else.
- `doctor` reports the hosts entry (if any), whether port 80 actually bound, and which mode each
  settings scope is currently wired to.
- Test-only overrides (never needed for normal use): `CODEX_GATEWAY_HOSTS_FILE` points detection at
  a different file, `CODEX_GATEWAY_COMPAT_PORT` changes the port from 80.

## Use with sidequest

If you also run [sidequest](../sidequest) from this marketplace, the two connect on their own. codex-gateway
publishes a catalog of its GPT-5.6 models (`catalog.json`, written on `setup`/`start`), and sidequest reads
it, so each model tier in the board's gear-menu settings gets a backend dropdown: run that tier on its
Claude model, or on one of your Codex models. Pick Terra behind the opus tier and opus-tier tickets run
Terra; sidequest generates a matching executor agent (restart Claude Code to load it). The ladder keeps
its shape, you're just choosing which model backs each tier. Nothing to wire: install both at user scope,
open the board settings, set the backends you want. See the sidequest README's *Per-tier Codex backend*
note for the routing side.

## The fine print

- **Context windows**: Codex GPT-5.6 through the ChatGPT Codex product (the subscription login this
  gateway routes to, not the pay-per-token API) has a 272k-token window, advertised as
  `max_input_tokens` on every Codex row. Those ids deliberately have no `[1m]` suffix. `[1m]` is a
  local Claude Code promise that delays compaction to roughly 1M tokens; the shim strips it before
  forwarding, so keep it off every selected Codex model, including the top-level `model` setting,
  and use it only for genuine Claude models. Claude models (opus/sonnet/fable, with or without
  `[1m]`) keep their OWN separate native windows and compaction limits; the shim forwards them
  byte-identically to Anthropic and never applies Codex window advertisement or error rewriting to
  them. The env block pins the real 1M aliases (`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8[1m]`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5[1m]`, `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5[1m]`)
  so a gateway session on any of them gets its true 1M window instead of Claude Code's 200k gateway
  default; haiku stays unpinned (it's 200k). On
  context overflow the shim emits HTTP 413 `request_too_large` (matching claude-code-proxy 0.1.14+,
  which first shipped that mapping) so Claude Code runs its built-in compact-and-retry path instead
  of stopping on the proxy's raw 5xx; an upstream 413 passes through untouched, and an older proxy's
  differently-shaped context error is normalized to the same 413. Do NOT set a global
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: it applies to Claude passthrough models too. Version 0.4.4
  rewrites stale pre-0.4.2 `[1m]` Codex rows in Claude Code's gateway-model cache in place and
  serves the built-in rows immediately during shim startup, so the model picker always has a valid
  fallback. Restart Claude Code once after upgrading so an already-open session reloads its picker.
  Version 0.4.2 removes the old global `CLAUDE_CODE_AUTO_COMPACT_WINDOW=950000` override when it
  rewrites settings. Legacy typed Codex ids ending in `[1m]` still route, but new sessions should
  select the unsuffixed picker rows. Loading a huge reference skill (e.g. `claude-api`, ~800k chars)
  in a single turn can spike Codex context past the point compaction can recover from, so pull large
  references incrementally on Codex models.
- **Model quality of life**: typed selection works too: `/model claude-codex-gpt-5.4`, any string
  passes through on a custom base URL. The advertised list itself is yours to edit:
  `~/.claude/codex-gateway/models.json`, one id per array entry (claude-code-proxy v0.1.10 has no
  `/v1/models` of its own; if a later version grows one, the shim prefers it automatically).
- **Reasoning display**: the Codex backend doesn't send thinking blocks back, so you get
  answers without the visible reasoning stream on Codex models. Upstream limitation.
- **Plan-mode tools are hidden from Codex models.** GPT models call `EnterPlanMode` /
  `ExitPlanMode` spuriously (they're not trained on Claude Code's tool ecosystem), and an
  approved plan exit downgrades your permission mode to "accept edits on" instead of restoring
  it ([anthropics/claude-code#39973](https://github.com/anthropics/claude-code/issues/39973)),
  which in bypass mode means sudden permission prompts on everything. The shim strips those two
  tools from Codex-bound requests; Claude models keep them. If you actually want plan mode with
  a GPT model, set `CODEX_GATEWAY_KEEP_PLAN_TOOLS=1` for the shim process.
- **Availability**: OpenAI has tightened client fingerprinting before (May 2026), which broke
  unofficial clients until they updated. When Codex models start dying mid-stream, re-run
  `setup` to pick up the latest proxy release. Claude models are never affected; worst case
  `env --remove` restores stock behavior instantly.
- **ToS**: routing your own subscription through a local proxy is a gray area OpenAI currently
  tolerates (and adjacent patterns they openly endorse), but it's your account; read the room
  before pointing this at anything that matters. This plugin stores no credentials itself;
  OAuth tokens live where claude-code-proxy puts them (`%APPDATA%\claude-code-proxy\` on
  Windows, Keychain on macOS).
- **Uninstalling**: run `env --remove` first, then remove the plugin; otherwise sessions keep
  pointing at a shim that no hook restarts.

## Support

codex-gateway is free and MIT-licensed. If it saves you time, [a coffee](https://ko-fi.com/eigenwise) or [a GitHub sponsorship](https://github.com/sponsors/Eigenwise) genuinely helps me keep building and maintaining these tools.

| Ko-fi | GitHub Sponsors |
|:-----:|:---------------:|
| <a href="https://ko-fi.com/eigenwise"><img height="32" alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a> | <a href="https://github.com/sponsors/Eigenwise"><img height="32" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white"></a> |

## License

MIT (c) Eigenwise
