---
name: model-gateway
description: >-
  Set up, update, or diagnose the local ChatGPT/Codex gateway for Claude Code's /model picker. Use
  for gateway setup, login, model visibility, routing, or failures.
---

# model-gateway

Two local processes give Claude Code native access to the user's ChatGPT subscription models:
`claude-code-proxy` (does OpenAI OAuth and translates Anthropic Messages API to the Codex
backend) and a shim router this plugin owns. `ANTHROPIC_BASE_URL` points at the shim: requests
for `claude-gpt-*` models are un-prefixed and go to the proxy, everything else passes through
to api.anthropic.com with the user's normal claude.ai login. The shim's `/v1/models` advertises
Codex models with a `claude-` prefix because Claude Code's model discovery drops ids that don't
start with `claude`/`anthropic`. That prefix is shared with the real Anthropic ids, so the route
is decided by the backend family segment (`claude-gpt-*`, `claude-grok-*`), never by the prefix.

All commands: `node "${CLAUDE_PLUGIN_ROOT}/bin/model-gateway.js" <command>`

## First-time setup

Project-local wiring is the standard setup. `env --write-project` writes the current project's `.claude/settings.local.json`, so the gateway stays configured for this project's sessions and executor worktrees without putting a machine-local endpoint in a committed file. `setup` uses the same project-local target.

`env --write-user` remains an opt-in shared fallback for people who deliberately want one gateway URL in `~/.claude/settings.json` across every project. Claude Code gives a current project's `settings.local.json` higher precedence, so `doctor` marks the winner `[effective]`, names both files, and says that project-local wiring wins when their gateway modes disagree.

The SessionStart hook injects a one-line nudge while the gateway is in any half-configured
state; act on it. The user sees that same line in the transcript, because a state only they can fix used to
reach the model alone. Anything routine stays out of it, and the hook always exits 0 so the line survives:
run `ensure` yourself when you need an exit code. SessionStart waits at most 12 seconds for a newly started
gateway, then leaves its supervisor to finish in the background so it stays inside Claude Code's hook budget. `setup` is one-shot and idempotent: it downloads the claude-code-proxy binary
(sha256-verified) and starts everything. Re-running it later is also the upgrade path.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/model-gateway.js" setup
# only if setup says sign-in is needed:
node "${CLAUDE_PLUGIN_ROOT}/bin/model-gateway.js" login    # browser OAuth; --device for headless
node "${CLAUDE_PLUGIN_ROOT}/bin/model-gateway.js" setup    # finishes the wiring
```

`login` opens the user's browser; they complete it themselves (suggest `! node ... login` if it
needs a real TTY). `env --write-project` writes this project's `.claude/settings.local.json`.
Use `env --write-user` only when the user wants a shared fallback across projects. If both are
present, project-local wiring wins: `doctor` marks it `[effective]`, names the shadowed user file,
and fails when their gateway modes differ. All wiring changes apply to new Claude Code sessions,
so restart after the write. The Codex rows appear in `/model` labeled "From gateway".

The winning `ANTHROPIC_BASE_URL` source follows Claude Code's precedence: process environment,
current-project `.claude/settings.local.json`, project `.claude/settings.json`, then user
`~/.claude/settings.json`. A process export always wins, so settings writes cannot replace it.

`env --write-user --reconcile` is confirmation-gated. Plain `env --write-user` writes the shared
user fallback, then lists recorded projects whose local URL differs without changing their files.
The confirmed command removes only Model Gateway-owned keys from those other projects'
`.claude/settings.local.json` files: its base URL, the three Claude alias pins, and static gateway
flags whose values equal plugin defaults. It leaves unrelated settings alone, skips projects already
agreeing, cannot change `process.env`, and needs a restart to affect a new session.
Discovery needs Claude Code v2.1.129+; `models` shows exactly what the shim advertises. Claude Code
only refetches gateway discovery when it has an API-key credential. OAuth subscriptions do not give it
one, so Model Gateway writes Claude Code's discovery cache whenever its advertised list changes.

Restart remains necessary to surface new rows in `/model`: Claude Code reads the picker cache once at
session start. `/reload-plugins` does not reload it. Restoring or refreshing auth on an already-wired
install needs no restart: the proxy is a separate process, so once `login` + `setup` re-authenticate it,
the next request routes through cleanly. The shim supervisor also probes the proxy's `/v1/models` endpoint
while it runs, restarting an unavailable proxy with single-flight bounded backoff. It leaves a healthy proxy
alone. Recovery output remains in `~/.claude/model-gateway/logs/guardian.log`; bounded lifecycle records in
`~/.claude/model-gateway/logs/lifecycle.jsonl` identify supervisor, worker, and proxy PIDs, orderly
stop/restart requests, observed exits, and recovery outcomes. Use `doctor` to print the evidence path and
the last observed exit. An OS termination or force-killed supervisor may leave no final record, so treat an
absent exit record as absence of evidence, not a clean shutdown. Process cleanup uses this home's recorded PIDs
and targeted ownership checks only: the live command must still identify this install, and the recorded command
or start time must match. A stale record is deleted without stopping its reused PID; `doctor` prints `stale pid
file guardian: PID <pid> is now <command>`. This matters when an agent is mid-orchestration
(e.g. dispatching Codex subagents through the gateway): do not tell the user to restart Claude Code just to
bring auth back, or you kill the session that was about to use it.

## Selecting models

- `/model` picker: rows like "GPT-5.6-sol (Codex)" and "Grok 4.5".
- Typed: `/model claude-gpt-5.6-sol[1m]` or `/model claude-grok-4.5[1m]`. The picker and Sidequest catalog emit those exact ids. The suffix is stripped before routing to Codex or Grok.
- `lib/runtime.js`'s exported `MODEL_WINDOW_POLICY` is the sole authority for gateway backend windows, picker aliases, advertised windows, and sentry mode. GPT-5.6 Sol, Terra, Luna, and GPT-6 Astra are measured rows. GPT ids absent from the table are deliberately advertised through its explicitly unmeasured 920k default, rather than silently inheriting a window. Grok 4.5 is a measured 500k row and now has the `[1m]` picker alias.
- Codex GPT-5.6 and GPT-6 Astra through the ChatGPT Codex product (the subscription login this gateway routes to, not the pay-per-token API) accepted 920,012 input tokens and refused 935,012 on 2026-09-05 through claude-code-proxy 0.1.35 (upstream 55bf0b58). The shim advertises `920000` by default for both families and, when `CODEX_GATEWAY_COMPACT_TRIGGER` is unset, sends a synthetic 413 at each model's window minus 40k tokens (880000 with the shipped window). `CODEX_GATEWAY_CONTEXT_WINDOW` overrides every advertised Codex window, while `CODEX_GATEWAY_COMPACT_TRIGGER` fixes the sentry trigger globally. Claude Code 2.1.261 ignores a settings-file `CLAUDE_CODE_MAX_CONTEXT_TOKENS` value for its own unrecognized-model resolver, so rows above 200k use their policy's recognized `[1m]` alias. That alias gives Claude Code a 1M client window, the closest available setting to the verified 920k backend window; the sentry keeps 40k of backend headroom. A lower explicit `autoCompactWindow` still wins, including this machine's intentional `325000` cap, and its fixed `CODEX_GATEWAY_COMPACT_TRIGGER=320000` remains earlier still.
- Claude models (opus/sonnet/fable, with or without `[1m]`) keep their OWN separate native windows
  and compaction limits: the shim forwards their requests byte-identically to Anthropic and never
  applies Codex window advertisement or error rewriting to them. The env block pins the current
  real 1M aliases (Opus, Sonnet, Fable) to `[1m]` ids so a gateway session on one gets its full 1M
  window instead of the 200k gateway default; Haiku stays unpinned (it's 200k). An `env --write-*`
  command resolves those aliases through the installed Claude CLI's credential-free headless probe;
  SessionStart refreshes its cache after the CLI changes or the cache ages out. A failed probe keeps
  the last good pin, then a shipped safe default. Set a persistent per-alias override with
  `pin --opus claude-opus-4-8[1m]` (same for `--sonnet` and `--fable`), or use `pin --opus default`
  to return to auto-detection. Overrides always win. `pin` with no arguments shows each effective
  pin and whether it is overridden. Overrides live in `~/.claude/model-gateway/pins.json`, outside
  the plugin cache. After a pin change or Claude CLI upgrade, run `env --write-project` (or
  `env --write-user` for a shared fallback) and start a new Claude Code session; changing a saved value alone cannot alter
  an open session.
- Do NOT set a
  global `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: it applies to both providers and can make Codex
  `/compact` fail after history already exceeds the Codex limit.
- Caution: loading a huge reference skill (e.g. `claude-api`, ~800k chars) in a single turn can
  spike Codex context past the point proactive compaction can recover from. Prefer pulling large
  references incrementally on Codex models.
- The advertised catalog is a built-in list (proxy v0.1.10 serves no /v1/models); override it in
  `~/.claude/model-gateway/models.json` (JSON array of ids).
- **RC-compat and missing Codex rows**: Remote Control and the Codex/Grok rows in `/model` cannot
  both work. RC-compatibility points `ANTHROPIC_BASE_URL` at `api.anthropic.com`, and Claude Code
  disables gateway model discovery for that host. The gateway still routes explicit ids: type
  `/model claude-gpt-5.6-terra[1m]`, and Claude Code accepts and saves it as the default. Disabling
  compatibility restores the picker rows. Sidequest dispatch is unaffected because it resolves its
  explicit route marker and never uses picker discovery.
- Claude models keep working normally at the same time (passthrough path); subagents can mix tiers
  freely.

## RC-compatibility mode (restoring `/remote-control`)

For the confirmation-gated procedure, use the `remote-control-compatibility` skill. It manages the
plugin-marked hosts block, creates a backup before an elevated write, reconciles gateway mode, and
checks the final state. Do not edit the hosts file outside that procedure.

Claude Code's `/remote-control` only lights up when `ANTHROPIC_BASE_URL` is exactly the real
Anthropic host, which conflicts with gateway model discovery. Remote Control and the Codex/Grok rows
in `/model` cannot both work. Before enabling compatibility, tell the user that the rows disappear
from the picker, while explicit ids such as `/model claude-gpt-5.6-terra` still work and persist as
the default. Disabling compatibility restores the rows. model-gateway offers an opt-in, fully
reversible workaround:

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

Logs live in `~/.claude/model-gateway/logs/`. `guardian.log` has recovery output; `lifecycle.jsonl`
has bounded process evidence that `doctor` summarizes. Ports: shim 18764, proxy 18765 (override with
`CODEX_GATEWAY_PORT` / `CODEX_GATEWAY_PROXY_PORT`, but the env block and running processes must
agree).

## Failure modes worth knowing

- **Every request fails after wiring**: a SessionStart hook can time out while it starts the shim. Claude Code cancels that hook, and a directly spawned supervisor can die with its process tree before it records an exit. Model Gateway launches the supervisor outside that tree and stops waiting before the hook budget, but if this is an older install or it still repeats, run
  `doctor`, check logs. Worst case `env --remove` restores stock behavior instantly.
- **Codex sessions drop while this plugin's suite runs**: this version scopes fixture cleanup to
  the test gateway home, so the suite never touches the installed gateway. If it happens after
  updating, run `doctor` and include its supervisor conflict line and lifecycle evidence.
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
  disables discovery), or RC-compatibility is active. Claude Code only refetches discovery with an
  API-key credential, so OAuth users rely on Model Gateway's cache write. Run `doctor` to check the
  cache, then restart Claude Code after it updates; `/reload-plugins` does not reload picker rows.
- **Thinking/reasoning**: the Codex backend doesn't return thinking blocks into Claude Code's
  UI; that's an upstream limitation, not a bug here.
- **Permission mode flips to "accept edits on" during Codex sessions**: caused by GPT models
  calling the plan-mode tools; an approved ExitPlanMode downgrades the mode instead of
  restoring it (anthropics/claude-code#39973). The shim strips EnterPlanMode/ExitPlanMode from
  Codex-bound requests since 0.2.1, so this shouldn't recur; if it does, make sure the shim was
  restarted (`stop` + `start`). Shift+Tab restores the mode in an affected session. Escape
  hatch to re-enable plan tools: `CODEX_GATEWAY_KEEP_PLAN_TOOLS=1`.
