# workspace-init

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fworkspace-init%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

## Deprecated

workspace-init moved into [Workbench](../workbench/README.md). Install Workbench at user scope, reload, then remove the old plugins:

```text
/plugin install workbench@eigenwise-toolshed --scope user
/reload-plugins
/plugin uninstall workspace-init@eigenwise-toolshed
/plugin uninstall toolshed-guard@eigenwise-toolshed
```

This plugin only keeps a session-start reminder while existing installs migrate. It has no skills, aliases, updater, or freshness guard.

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
