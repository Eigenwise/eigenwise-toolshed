# No downstream sink

Set `observability.sink` to `none` for the local ledger and reports without a downstream hop. The observer does not create or flush outbox rows in this mode.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../../../../sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
