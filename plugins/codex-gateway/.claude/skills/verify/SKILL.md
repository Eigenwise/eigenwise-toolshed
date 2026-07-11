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

Keep the real gateway and user settings untouched. Capture response bodies and resulting settings JSON inline.
