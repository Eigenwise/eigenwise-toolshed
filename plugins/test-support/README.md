# test-support

Internal test helper code for the Eigenwise Toolshed repository. This directory is not a Claude Code
plugin and has no `.claude-plugin/plugin.json`, skills, hooks, or release version.

> Start with the [test-support guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/test-support/), then see the [full docs site](https://eigenwise.github.io/eigenwise-toolshed/).

Test-support is project-scoped internal tooling, not a user-installable plugin. It travels with the repository and is not installed separately.

## `windows-hide.js`

The helper scans JavaScript production files for `child_process` calls and reports whether each call hides
the Windows console window with `windowsHide: true`. It exports:

- `inspectSource(source, file)`, which finds calls in one source string and records the file, line, call
  name, and whether it is hidden.
- `inspectPlugin(root)`, which recursively scans a plugin directory while skipping `.claude`,
  `.claude-plugin`, `node_modules`, and `test` directories.
- `unhiddenCalls(calls)`, which filters the scan to calls that still expose a console window.

The parser handles nested calls, strings, line comments, and block comments so the check does not mistake
text for a process call.

## Used by tests

Plugin test suites import this helper with a relative path. Current consumers include:

- `plugins/model-gateway/test/windows-hide.test.js`
- `plugins/sidequest/test/windows-hide.test.ts`
- `plugins/sidequest/test/agentsync.test.ts`
- `plugins/workbench/test/windows-hide.test.js`

It exists to keep the Windows process-visibility policy in one test utility. It is not part of any plugin's
runtime or public install surface, and users should not install it separately.

## License

MIT, under the repository license.
