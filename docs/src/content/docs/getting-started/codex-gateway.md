---
title: Codex Gateway setup
description: Use your ChatGPT and Codex subscription models from Claude Code.
---

Codex Gateway runs a local proxy and puts `claude-codex-*` models in Claude Code's `/model` picker. It uses your ChatGPT/Codex subscription through the supported proxy, so no OpenAI API key is required.

```text
/plugin install codex-gateway@eigenwise-toolshed --scope user
/codex-gateway:codex-gateway setup
```

The setup skill installs or updates the proxy, checks authentication, and starts the local gateway. Use `/codex-gateway:codex-gateway doctor` when the picker is missing models or the gateway port is unavailable. Once it is healthy, choose a `claude-codex-*` model with `/model`; regular Claude model ids continue to use the Anthropic API.

Gateway wiring defaults to each recorded project's private `.claude/settings.local.json`, so it does not write the team's committed `settings.json`. Run `/update-toolshed` to wire recorded projects and migrate an older global gateway block. For a project that has not been recorded, run `node <plugin>/bin/codex-gateway.js env --write-project` from that project. Global `~/.claude/settings.json` wiring remains available with `env --mode global` when you explicitly choose it. Wiring applies to new Claude Code sessions, so restart open sessions after changing it.

Claude Code Remote Control cannot use a local `ANTHROPIC_BASE_URL` in the same way. Run `/codex-gateway:remote-control-compatibility` to safely switch compatibility mode on or off before using Remote Control, then restore gateway mode when you return.
