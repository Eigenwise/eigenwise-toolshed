# Toolshed guard

`toolshed-guard` checks active `@eigenwise-toolshed` plugin installs before each prompt. When the last successful release check proves one is behind, it blocks the prompt before Claude receives it. A user-scoped `workbench@eigenwise-toolshed` install takes over this check, so the legacy guard stays silent.

Install it once at user scope so it covers every project:

```sh
claude plugin install toolshed-guard@eigenwise-toolshed --scope user
```

When blocked, run `/update-toolshed`, then `/reload-plugins` or restart Claude Code. Resubmit the prompt after reload. If `workspace-init` is gone, run `/plugin install workbench@eigenwise-toolshed --scope user` instead. `/update-toolshed`, `/reload-plugins`, and exact `/plugin` maintenance commands remain available for recovery.

For an emergency only, start Claude Code with `EIGENWISE_TOOLSHED_FRESHNESS_BYPASS=1`, then remove the override once updates are possible. Missing state, invalid state, and remote failures fail open. Previously proven stale installs stay blocked until the installed registry shows the update.
