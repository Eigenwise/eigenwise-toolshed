---
title: Whittle
description: One practical clean-code policy for supported coding-agent hosts.
---

Whittle applies one practical clean-code policy wherever its host integration supports it. It starts from the real flow, questions whether a change needs to exist, reuses code before adding it, then favors the standard library, native capabilities, and small shared-root fixes. Safety, accessibility, validation, permissions, and data-loss safeguards stay in place.

## Install for Claude Code

After Whittle is registered in the marketplace, install it at the scope you chose:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install whittle@eigenwise-toolshed --scope project
```

Enabling the plugin applies the policy automatically at session and subagent start. Disable the plugin through Claude Code to remove it. There are no modes, defaults, commands, environment switches, or saved Whittle preferences. Mode selection, saved default state, and a Whittle statusline are intentionally absent: one fixed policy is the product.

If another clean-code injector is active, disable it there yourself, then run `/reload-plugins` or restart before enabling Whittle. That avoids stacking two policies. Whittle never changes that other tool's configuration or imports its state.

## Other hosts

`plugins/whittle/exports/` contains generated self-contained instructions for static host formats. Generate them into a destination you chose, then copy one host directory to its documented consumer location yourself:

```text
node plugins/whittle/scripts/generate-host-exports.js --out /your/chosen/directory
```

Gemini's export is `GEMINI.md`. Cursor's export is an always-applied `.cursor/rules/whittle.mdc` rule. OpenCode, Pi, and Hermes adapters reuse their native instruction callbacks. The MCP server exposes a parameterless `whittle` prompt and `whittle_instructions` read-only tool, both returning the same policy and `persistence:none`.

The MCP stdio transport was checked with an isolated SDK dependency install. OpenCode, Pi, Hermes, and static-host exports have callback or file-format checks only. Their consumer binaries were not installed or run.

## Optional read-only reports

Whittle has no command. When Sidequest is available, use its existing readonly submitted-candidate review, named-scope repository audit, and source-comment debt scan recipes. Sidequest owns those flows. Whittle does not measure gains, and gains stay unmeasured without a matched baseline.
