# Model Gateway

Model Gateway puts your ChatGPT/Codex and Grok subscription models in Claude Code's `/model` picker. Claude requests keep using your normal Claude login. No OpenAI API key is required.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/model-gateway/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/model-gateway/) · [Toolshed marketplace](../../README.md)

## Install

Install at user scope so the keepalive hook works in every project:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install model-gateway@eigenwise-toolshed --scope user
/model-gateway:model-gateway setup
```

If setup asks you to sign in, run `/model-gateway:model-gateway login`, finish the browser OAuth flow, and run setup again. Restart Claude Code after setup so it discovers the new model rows.

The gateway writes its wiring to your user settings. To remove that wiring before uninstalling:

```text
/model-gateway:model-gateway env --remove
```

## First successful use

1. Restart Claude Code.
2. Run `/model`.
3. Select a row labeled `From gateway`, or type a model id such as `claude-gpt-5.6-terra`.
4. Run `doctor` if the rows are missing:

```bash
node <plugin>/bin/model-gateway.js doctor
node <plugin>/bin/model-gateway.js models
```

The GPT rows use the ChatGPT/Codex subscription route. Grok rows use the official Grok CLI subscription route when that CLI is installed and signed in. Claude models continue through Anthropic.

## Commands

```text
setup                         download or update the local proxy and start the gateway
login [--device]              sign in to ChatGPT/Codex, with device login for headless hosts
start / stop / status          manage the local proxy and shim
ensure                         start anything that is down
models                        show models advertised to Claude Code
catalog [--json]              show the catalog consumed by Sidequest
pin --opus|--sonnet|--fable   show or save a native Claude alias pin
env --write-user              write user-level gateway wiring
env --remove                  remove only gateway-owned wiring
doctor                        check auth, processes, ports, models, and wiring
remote-control enable|disable|doctor
                              manage Remote Control compatibility
```

The executable lives at `<plugin>/bin/model-gateway.js`. The plugin's [generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/model-gateway/) has the complete command and configuration reference.

## Remote Control

Remote Control and gateway model discovery cannot both be active. Use the `remote-control-compatibility` skill to switch modes. Compatibility mode hides gateway rows from `/model`; an explicit id such as `/model claude-gpt-5.6-terra` still routes through the gateway. Restart Claude Code after changing modes.

## Troubleshooting

- **No gateway rows:** restart Claude Code, then run `models` and `doctor`. Discovery requires Claude Code v2.1.129 or newer.
- **Codex errors, Claude works:** run `login` if `doctor` reports missing auth, then run `setup` again.
- **A local process is down:** run `ensure`.
- **A project overrides the gateway:** `doctor` shows which settings source wins. A project or process-level `ANTHROPIC_BASE_URL` takes precedence over user settings.

## Sidequest

If you also install [Sidequest](../sidequest), it reads the gateway's model catalog and can use GPT-5.6 models as routed backends. Install both plugins at user scope, then choose the backend in Sidequest settings.

## License

MIT
