---
name: verify
summary: Verify model-gateway through its CLI and HTTP shim surface.
---

# Verify model-gateway

Use an isolated temporary home and random localhost ports. Start `bin/model-gateway.js serve-shim` against a tiny fake HTTP proxy that serves `/v1/models` and records forwarded message bodies.

Drive these surfaces:

1. `GET /v1/models` through the running shim.
2. `POST /v1/messages` using both current and legacy model IDs, then inspect the fake proxy's received model.
3. `ensure --quiet` with a temporary `~/.claude/settings.json` containing legacy settings. It always exits 0 for the SessionStart hook, including when no proxy binary exists; inspect the structured hook notice and settings mutation instead. When startup exceeds the 12-second wait, verify the notice asks for a retry while the supervisor finishes in the background.
4. `env --write-project` against a temporary project directory to check that wiring lands in that project's `.claude/settings.local.json` and never in a committed `.claude/settings.json`. Then `env --write-user` against a temporary HOME for the shared fallback, checking preservation of user-set values. With both set, `doctor` must name the project-local one as effective and fail a mode contradiction. `--mode` and `--show-mode` are retired and must exit 2.
5. RC-compatibility mode: set `CODEX_GATEWAY_HOSTS_FILE` to a temp hosts file and `CODEX_GATEWAY_COMPAT_PORT` to a free ephemeral port (never the real 80) before starting `serve-shim`. With the file containing `127.0.0.1 api.anthropic.com`, `GET /healthz` on both the main port and the compat port must report `compat.hostsDetected: true` and `compat.port80Bound: true`. With the entry absent, both must be false and the compat port must refuse connections. Pre-binding the compat port before spawning the shim proves the safe fallback: `hostsDetected: true`, `port80Bound: false`, a populated `reason`, and the main port still serving normally.
6. DNS-recursion guard: require `lib/request-worker.js` directly and call `createHostsBypassResolver({ resolve4, resolve6 })` with injected fake resolvers to confirm it never falls back to a hosts-aware lookup and errors closed when both resolvers fail.

Drive real `setup --preserve-wiring` with failing acquisition and assert the intentional-stop marker survives; maintenance setup must also avoid starting a stopped gateway after successful acquisition. Intentional stop is cleared once an explicit `start` or `setup` creates the supervisor process and records its PID; drive a spawn that yields no PID (nonexistent executable on the POSIX branch) and a launch-directory failure and assert the marker survives with no guardian record. Drive the installed stable gate without an install: a non-gateway endpoint exits 0 before CLI resolution or spawn, while a wired endpoint exits 2 with actionable guidance. Keep separate assertions for an absent plugin entry (recovery remains active), an explicit effective `enabledPlugins["model-gateway@eigenwise-toolshed"]: false` (exit 0, notice, no spawn or state changes), and `disableAllHooks`. Check project-local, project and user precedence, process endpoint precedence, and doctor's explicit-disable line.

Keep the real gateway and user settings untouched. Capture response bodies and resulting settings JSON inline.

Exercise the installed stable hook command with JSON stdin, not just its helpers. Use isolated HOME/Claude state and ephemeral ports with at most two workers. Check startup/resume without enabled plugins, concurrent recover/ensure callers sharing one supervisor, delayed readiness and deadline refusal, stale records after simulated shutdown, supervisor death, and fake-backend streamed inference after recovery. Keep a healthy concurrent stream open during repeated gates and assert its output and supervisor identity stay intact.

The gate guards router health only (owned listener, installed serving version and `/healthz`); assert that a Codex-only auth or upstream failure never blocks a prompt and stays visible in `doctor` and per-request errors.

Check registry upgrade/downgrade after deleting the old fixture install, missing install, unavailable/auth failure and foreign listener safety. Check exact owned-hook merge/dedup/removal, user fallback and process precedence, disabled hooks, intentional stop across new processes, explicit start resumption, and unwire. The gate child deadline is 25 seconds, below its 35-second hook timeout with `onFailure: block`; SessionStart attempts recovery but cannot block. Actual reboot and credentialed provider inference are separate acceptance evidence and must be reported separately.
