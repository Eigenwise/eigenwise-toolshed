---
name: codex-gateway
description: >-
  Manage the local gateway that puts ChatGPT/Codex subscription models in Claude Code's /model
  picker. Use for: "set up codex gateway", "codex models missing from /model", "switch to
  GPT/codex model isn't working", "codex gateway is down/broken", "stop routing through the
  gateway", or any setup/login/diagnosis of the Codex-in-Claude-Code integration.
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

The SessionStart hook injects a one-line nudge while the gateway is in any half-configured
state; act on it. `setup` is one-shot and idempotent: it downloads the claude-code-proxy binary
(sha256-verified), starts everything, and wires `env --write-user` automatically when ChatGPT
auth is already valid. Re-running it later is also the upgrade path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup
# only if setup says sign-in is needed:
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" login    # browser OAuth; --device for headless
node "${CLAUDE_PLUGIN_ROOT}/bin/codex-gateway.js" setup    # finishes the wiring
```

`login` opens the user's browser; they complete it themselves (suggest `! node ... login` if it
needs a real TTY). Prefer `env --write-project` over the default user-wide wiring only if the
user wants Codex models in this repo alone. After `env --write-user`, the user restarts Claude Code and
the Codex rows appear in `/model` labeled "From gateway". Discovery needs Claude Code v2.1.129+
and fails silently if the shim answers slowly; `models` shows exactly what's advertised.

## Selecting models

- `/model` picker: rows like "GPT-5.6-sol (Codex)".
- Typed: `/model claude-codex-gpt-5.6-sol` (any string passes through on a custom base URL).
- Codex GPT-5.6 through the ChatGPT Codex product (the subscription login this gateway routes to,
  not the pay-per-token API) has a 272k window, advertised as `max_input_tokens` on every Codex row;
  their ids stay unsuffixed. `[1m]` is only a local Claude Code promise, not provider capacity
  metadata. On context overflow the shim emits HTTP 413 `request_too_large` (matching
  claude-code-proxy 0.1.14+), which triggers Claude Code's compact-and-retry. Legacy typed Codex ids
  ending in `[1m]` still route, but they retain a 1M client budget for that open session: switch to
  the unsuffixed picker row and restart Claude Code after upgrading from 0.4.1.
- Claude models (opus/sonnet/fable, with or without `[1m]`) keep their OWN separate native windows
  and compaction limits: the shim forwards their requests byte-identically to Anthropic and never
  applies Codex window advertisement or error rewriting to them. The env block pins the real 1M
  aliases (Opus, Sonnet, Fable) to their `[1m]` ids so a gateway session on one gets its full 1M
  window instead of the 200k gateway default; Haiku stays unpinned (it's 200k). Do NOT set a
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

For the confirmation-gated workflow, use the `remote-control-compatibility` skill. It manages the
plugin-marked hosts block, creates a backup before an elevated write, reconciles gateway mode, and
checks the final state. Do not edit the hosts file outside that workflow.

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
