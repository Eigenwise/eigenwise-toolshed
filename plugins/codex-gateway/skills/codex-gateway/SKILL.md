---
name: codex-gateway
description: >-
  Set up, update, or diagnose the local ChatGPT/Codex gateway for Claude Code's /model picker. Use
  for gateway setup, login, model visibility, routing, or failures.
---

# codex-gateway

Two local processes give Claude Code native access to the user's ChatGPT subscription models:
`claude-code-proxy` (does OpenAI OAuth and translates Anthropic Messages API to the Codex
backend) and a shim router this plugin owns. `ANTHROPIC_BASE_URL` points at the shim: requests
for `claude-codex-*` models are un-prefixed and go to the proxy, everything else passes through
to api.anthropic.com with the user's normal claude.ai login. The shim's `/v1/models` advertises
Codex models with the `claude-codex-` prefix because Claude Code's model discovery drops ids
that don't start with `claude`/`anthropic`.

All commands: `node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" <command>`

## First-time setup

Before wiring a machine with no saved mode (`env --show-mode` says it defaulted), ask exactly once: **"Global (all projects wired automatically via user settings) or per-project (each project opts in via its private settings.local.json — recommended)?"** Global gives zero-friction coverage everywhere. Per-project keeps personal wiring out of shared repos and makes each opt-in explicit. Persist the answer with `env --mode global` or `env --mode local`; do not ask again once a mode exists. If setup must run without interaction, use local and say `wiring mode defaulted to per-project; run codex-gateway env --mode global to change`.

The SessionStart hook injects a one-line nudge while the gateway is in any half-configured
state; act on it. `setup` is one-shot and idempotent: it downloads the claude-code-proxy binary
(sha256-verified) and starts everything. Re-running it later is also the upgrade path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup
# only if setup says sign-in is needed:
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" login    # browser OAuth; --device for headless
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup    # finishes the wiring
```

`login` opens the user's browser; they complete it themselves (suggest `! node ... login` if it
needs a real TTY). Local wiring is the default: run `env --write-project` from the current repo,
or `/workbench:update-toolshed` to wire recorded projects and migrate an older global block. It writes
`.claude/settings.local.json`; unrecorded projects stay unwired until explicitly wired. To switch a
saved mode and migrate recorded projects, run `/workbench:update-toolshed --wiring-mode local` or
`/workbench:update-toolshed --wiring-mode global`. The global switch preserves existing local blocks
and names them as redundant; it never deletes them. All wiring changes apply to new Claude Code sessions, so restart after the
write. The Codex rows appear in `/model` labeled "From gateway". Discovery needs Claude Code
v2.1.129+ and fails silently if the shim answers slowly; `models` shows exactly what's advertised.

That restart is ONLY to surface new model rows in `/model` — model discovery happens once at
session start. Restoring or refreshing auth on an already-wired install needs no restart: the
proxy is a separate process, so once `login` + `setup` re-authenticate it, the next request
routes through cleanly. This matters when an agent is mid-orchestration (e.g. dispatching Codex
subagents through the gateway) — do not tell the user to restart Claude Code just to bring auth
back, or you kill the session that was about to use it.

## Selecting models

- `/model` picker: rows like "GPT-5.6-sol (Codex)".
- Typed: `/model claude-codex-gpt-5.6-sol` (any string passes through on a custom base URL).
- Codex GPT-5.6 through the ChatGPT Codex product (the subscription login this gateway routes to,
  not the pay-per-token API) has a measured 370k input ceiling. The shim advertises `370000` as
  `max_input_tokens` by default; override it with `CODEX_GATEWAY_CONTEXT_WINDOW` when tuning a
  machine-specific setup. That advertised value is inert: Claude Code hardwires its own 200k gateway
  budget for discovered `claude-codex-*` rows. The backend's HTTP 413 `request_too_large` response is
  the recovery signal for context overflow. Legacy typed Codex ids ending in `[1m]` still route, but
  they retain a 1M client budget for that open session: switch to the unsuffixed picker row and
  restart Claude Code after upgrading from 0.4.1.
- Claude models (opus/sonnet/fable, with or without `[1m]`) keep their OWN separate native windows
  and compaction limits: the shim forwards their requests byte-identically to Anthropic and never
  applies Codex window advertisement or error rewriting to them. The env block pins the real 1M
  aliases (Opus, Sonnet, Fable) to their `[1m]` ids so a gateway session on one gets its full 1M
  window instead of the 200k gateway default; Haiku stays unpinned (it's 200k). Set a persistent
  per-alias override with `pin --opus claude-opus-4-8[1m]` (same for `--sonnet` and `--fable`), or
  use `pin --opus default` to return to the shipped pin. `pin` with no arguments shows each effective
  pin and whether it is overridden. Overrides live in `~/.claude/codex-gateway/pins.json`, outside
  the plugin cache. After a change, run `env --write-project` (or `env --write-user`) and start a
  new Claude Code session; changing the saved override alone cannot alter an open session.
- Do NOT set a
  global `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: it applies to both providers and can make Codex
  `/compact` fail after history already exceeds the Codex limit.
- Caution: loading a huge reference skill (e.g. `claude-api`, ~800k chars) in a single turn can
  spike Codex context past the point proactive compaction can recover from. Prefer pulling large
  references incrementally on Codex models.
- The advertised catalog is a built-in list (proxy v0.1.10 serves no /v1/models); override it in
  `~/.claude/codex-gateway/models.json` (JSON array of ids).
- Claude models keep working normally at the same time (passthrough path); subagents can mix
  tiers freely.

## RC-compatibility mode (restoring `/remote-control`)

For the confirmation-gated procedure, use the `remote-control-compatibility` skill. It manages the
plugin-marked hosts block, creates a backup before an elevated write, reconciles gateway mode, and
checks the final state. Do not edit the hosts file outside that procedure.

Claude Code's `/remote-control` only lights up when `ANTHROPIC_BASE_URL` is exactly the real
Anthropic host, which conflicts with gateway routing. codex-gateway offers an opt-in, fully
reversible workaround instead of pretending both can coexist by default:

- The user (never this plugin, never automatically) adds one hosts entry mapping
  `api.anthropic.com` to loopback — `127.0.0.1 api.anthropic.com` on Windows
  (`C:\Windows\System32\drivers\etc\hosts`, needs Administrator), macOS, and Linux (`/etc/hosts`,
  needs `sudo`). If asked to help with this, tell the user the exact line and file, and that they
  need elevated privileges to save it; do not attempt to edit the hosts file yourself.
- `ensure`/`setup`/`doctor` detect the entry (read-only) and, only after confirming the shim can
  actually bind loopback port 80, switch `ANTHROPIC_BASE_URL` to `http://api.anthropic.com` and
  start a second listener on port 80 next to the usual `127.0.0.1:18764`. Exactly one line tells
  the user to restart Claude Code when the mode changes either direction.
- Removing the hosts entry, or port 80 becoming unavailable (no permission, or something else is
  using it), reverts to default mode automatically, again with one restart line.
- `doctor` reports the hosts entry (if any), whether port 80 actually bound (and why not if it
  didn't), and which mode each settings scope (user/project) is wired to.
- Test/advanced overrides: `CODEX_GATEWAY_HOSTS_FILE` (custom hosts path), `CODEX_GATEWAY_COMPAT_PORT`
  (port other than 80). Neither is needed for normal use.

## Day-2 operations

```bash
... status      # what's running
... doctor      # binary, auth, ports, model count, settings wiring
... ensure      # start whatever is down (SessionStart hook runs this with --quiet)
... stop
... env --remove   # unwire Claude Code (do this BEFORE uninstalling the plugin)
```

Logs live in `~/.claude/codex-gateway/logs/`. Ports: shim 18764, proxy 18765 (override with
`CODEX_GATEWAY_PORT` / `CODEX_GATEWAY_PROXY_PORT`, but the env block and running processes must
agree).

## Failure modes worth knowing

- **Every request fails after wiring**: shim is down and the hook couldn't start it. Run
  `doctor`, check logs. Worst case `env --remove` restores stock behavior instantly.
- **Codex models error, Claude models fine**: proxy or OpenAI side. Check `login` state
  (`doctor` shows auth), then proxy log. OpenAI gates non-Codex clients by request fingerprint;
  when they tighten it, requests die mid-stream until claude-code-proxy ships a fix, so
  suggest re-running `setup` (it fetches the latest release).
- **`doctor` shows `Not authenticated` right after an upgrade**: bumping the proxy binary (e.g.
  0.1.10 → 0.1.17 via `setup`) can invalidate the credential the old version accepted — the new
  binary reads it as not authenticated and `setup` stops before wiring. Fix: re-run `login`, then
  `setup` again to finish. Until then every Codex model is down, so any run that routes to
  Codex (a whole sidequest board of Codex-tier tickets, for one) stalls entirely.
- **No "From gateway" rows in /model**: discovery is off (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
  missing), Claude Code < v2.1.129, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (it
  disables discovery), or the shim had no model cache yet; check `models`, restart the session.
- **Thinking/reasoning**: the Codex backend doesn't return thinking blocks into Claude Code's
  UI; that's an upstream limitation, not a bug here.
- **Permission mode flips to "accept edits on" during Codex sessions**: caused by GPT models
  calling the plan-mode tools; an approved ExitPlanMode downgrades the mode instead of
  restoring it (anthropics/claude-code#39973). The shim strips EnterPlanMode/ExitPlanMode from
  Codex-bound requests since 0.2.1, so this shouldn't recur; if it does, make sure the shim was
  restarted (`stop` + `start`). Shift+Tab restores the mode in an affected session. Escape
  hatch to re-enable plan tools: `CODEX_GATEWAY_KEEP_PLAN_TOOLS=1`.
