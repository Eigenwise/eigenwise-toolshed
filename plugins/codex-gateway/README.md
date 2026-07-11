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
  `claude` or `anthropic`. So the shim advertises the proxy's models as `claude-codex-<id>[1m]`
  with readable display names, strips the prefix on the way through, and passes every
  non-Codex request to api.anthropic.com byte-for-byte (your claude.ai auth, prompt caching,
  and beta headers are untouched).
- A **SessionStart hook** keeps both processes alive so a wired session never starts against a
  dead port.
- codex-gateway also publishes a small model catalog (`catalog.json`, next to its state) that
  [sidequest](../sidequest) reads to offer these Codex models in its own routing ladder.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codex-gateway@eigenwise-toolshed
```

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

## The fine print

- **1M context window**: the Codex GPT-5.x models carry a 1M-token window, same as `opus[1m]`
  and `sonnet[1m]`. The advertised ids carry the `[1m]` suffix, which behind a custom base URL
  is how Claude Code opts into the full window (it can't verify 1M support through a gateway
  otherwise). The env block also sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=950000` so long sessions
  compact near the real ceiling rather than early. That threshold is global, so keep the session
  on 1M models (the Codex tiers plus `opus[1m]`/`sonnet`); drop the key from your settings if you
  routinely run a 200k Claude model through the shim. The shim strips the suffix and the
  `claude-codex-` prefix before anything goes upstream.
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
