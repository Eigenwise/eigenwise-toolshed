---
name: verify
summary: Verify codex-gateway through its CLI and HTTP shim surface.
---

# Verify codex-gateway

Use an isolated temporary home and random localhost ports. Start `bin/codex-gateway.js serve-shim` against a tiny fake HTTP proxy that serves `/v1/models` and records forwarded message bodies.

Drive these surfaces:

1. `GET /v1/models` through the running shim.
2. `POST /v1/messages` using both current and legacy model IDs, then inspect the fake proxy's received model.
3. `ensure --quiet` with a temporary `~/.claude/settings.json` containing legacy settings. The command may exit nonzero when no proxy binary exists; inspect the settings mutation itself.
4. `env --write-project` in a temporary project to check wiring and preservation of user-set values.
5. RC-compatibility mode: set `CODEX_GATEWAY_HOSTS_FILE` to a temp hosts file and `CODEX_GATEWAY_COMPAT_PORT` to a free ephemeral port (never the real 80) before starting `serve-shim`. With the file containing `127.0.0.1 api.anthropic.com`, `GET /healthz` on both the main port and the compat port must report `compat.hostsDetected: true` and `compat.port80Bound: true`. With the entry absent, both must be false and the compat port must refuse connections. Pre-binding the compat port before spawning the shim proves the safe fallback: `hostsDetected: true`, `port80Bound: false`, a populated `reason`, and the main port still serving normally.
6. DNS-recursion guard: require the CLI module directly and call `createHostsBypassResolver({ resolve4, resolve6 })` with injected fake resolvers to confirm it never falls back to a hosts-aware lookup and errors closed when both resolvers fail.

Keep the real gateway and user settings untouched. Capture response bodies and resulting settings JSON inline.
