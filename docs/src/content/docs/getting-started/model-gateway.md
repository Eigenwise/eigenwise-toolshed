---
title: Model Gateway setup
description: Use ChatGPT, Codex, and Grok subscription models from Claude Code.
---

Model Gateway adds subscription-backed GPT and Grok models to Claude Code's `/model` picker. Claude requests still use your normal Claude login. You don't need an OpenAI API key.

## Install and start

Install it for your user account so the keepalive hook is available in every project:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope user
```

Then run setup:

```text
/model-gateway:model-gateway setup
```

Setup downloads the proxy, starts the local gateway, and asks you to sign in if needed. If setup asks for authentication, run `/model-gateway:model-gateway login` in the same session, finish the browser sign-in, then run setup again.

The gateway writes one user-level settings block. Wiring changes apply to new Claude Code sessions, so restart Claude Code after setup. Per-project wiring is not supported by this setup path.

:::caution
ChatGPT/Codex access uses the subscription login handled by `claude-code-proxy`. Grok access uses the official Grok CLI login. The gateway does not store either service's credentials.
:::

## Choose a model

After restarting, run `/model` and choose a row labeled `From gateway`. You can also type a model id directly:

```text
/model claude-gpt-5.6-sol
/model claude-gpt-5.6-terra
/model claude-gpt-5.6-luna
```

The `claude-gpt-*` rows use the ChatGPT/Codex subscription route. `claude-grok-*` rows use the Grok subscription route when the Grok CLI is installed and signed in. Claude models continue to use Anthropic normally.

Use `/model-gateway:model-gateway models` if the picker has no gateway rows. The full generated [Model Gateway reference](../reference/model-gateway/) lists the advertised models and command details.

## Update or check the gateway

`setup` is also the update path. Run it again to download the current proxy and restart the local services when needed.

Useful commands:

```text
/model-gateway:model-gateway status
/model-gateway:model-gateway doctor
/model-gateway:model-gateway ensure
/model-gateway:model-gateway stop
```

Use `doctor` for authentication, local process, port, model-list, and settings-wiring checks. Use `ensure` when a local process is down.

## Common fixes

- **Gateway rows are missing:** restart Claude Code, then run `models` and `doctor`. Discovery needs Claude Code v2.1.129 or newer.
- **Codex models fail but Claude works:** run `login` if `doctor` reports missing authentication, then run `setup` again.
- **Every model request fails:** run `doctor`, then `ensure`. `env --remove` removes the gateway wiring and restores the normal Claude path.
- **A project ignores the gateway:** check `doctor` for the settings file winning over the user settings. A project or process-level `ANTHROPIC_BASE_URL` override takes precedence.

To remove the wiring before uninstalling the plugin:

```text
/model-gateway:model-gateway env --remove
```

## Remote Control compatibility

Remote Control and gateway model discovery cannot be active together. Use `/model-gateway:remote-control-compatibility` to switch modes. Compatibility mode hides gateway rows from `/model`, but explicit ids such as `/model claude-gpt-5.6-terra` still route through the gateway. Restart Claude Code when the mode changes.

For exhaustive commands and advanced behavior, see the generated [Model Gateway reference](../reference/model-gateway/).
