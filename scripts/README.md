# Repository scripts

The scripts here support repository maintenance and release work. The release engine lives in
`scripts/release/`; its README is the source for fragment, planning, cut, and guard commands.

Release publication normally uses `node scripts/release/cut.mjs --push`. Preview with
`node scripts/release/cut.mjs --dry-run` first; `--push` acquires the Sidequest publish lock before
it changes the release window and releases it after the push or a failure. If another publisher
holds the lock, it stops before changing the window. Wait for the holder, or reclaim a confirmed
stale lock with `sidequest publish lock --steal --by <who>`.

For the manual fallback, acquire the Sidequest publish lock, run `cut.mjs` without `--push`, use
its printed `git push --atomic` command, then unlock.

The release tests run with Node 22 and use throwaway local repositories for git behavior:

```bash
node --test scripts/release/test/*.test.mjs
```

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../plugins/sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
