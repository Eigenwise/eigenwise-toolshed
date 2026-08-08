# Idle notifications wake the orchestrator without actionable state

A teammate that goes idle sends the orchestrator `{"type":"idle_notification","idleReason":"available"}`. That message wakes the main loop, which re-reads its entire context to process it, even though the message carries no submission, checkpoint, blocker, or other state the orchestrator can act on. It is a liveness ping charged at the price of a full context read.

## Reproduction

1. Start an orchestrator session with teammates enabled.
2. Spawn one or more teammates and let one become idle.
3. Observe the teammate message delivered to the orchestrator:

   ```json
   {"type":"idle_notification","idleReason":"available"}
   ```

4. Continue the session and inspect the main-loop turns. Each idle notification wakes the loop and causes the existing context to be read again, although the notification contains no submission, checkpoint, blocker, or actionable state.
5. In a session with several teammates, compare the number of main-loop turns with the idle notifications received. In one observed session, roughly half of the 40 main-loop turns were idle notifications.

## Measurement

Across all 31 projects in `~/.claude/projects` over 7 days, records were deduped on `requestId || message.id`, keeping the **last** record for each key. The role split was taken from `isSidechain`:

```text
MAIN LOOP    $3,493    23,875 requests (24%)    $0.146/request
SUBAGENTS    $1,980    74,697 requests (76%)    $0.027/request
```

The orchestrator costs 5.4x per request what a subagent does because every wake re-reads its whole context. The dedupe rule matters: first-wins deduplication undercounts, while this measurement keeps the last record for `requestId || message.id`.

Across every project, cache reads account for 65% of spend. The cache itself is healthy: the write-to-read token ratio is 1:73, and cache writes account for only 18% of spend. This points to request count against a large context, rather than cache expiry or cache thrash.

## Impact

One avoided main-loop wake is worth roughly five avoided subagent calls. That makes the main loop the higher-value optimization target, even though subagents generate more requests overall.

An orchestrator running a long session pays for each idle ping once per remaining turn because context is resent every turn. A notification with no state to process therefore adds repeated context-read cost without moving the work forward. In the observed session, idle notifications accounted for roughly half of the 40 main-loop turns.

## Workarounds considered

No workaround is available on our side. The message is produced by Claude Code's teammate messaging and delivered to the main loop.

We checked the marketplace plugins with:

```text
$ rg "idle_notification|idleReason" plugins/
(no matches)
```

No plugin in this marketplace emits, receives, or filters `idle_notification` or `idleReason`. There is no plugin hook, setting, or handler that can suppress or batch these messages, and there is no plugin-side workaround to propose.

## Requested fixes

1. **Highest priority:** do not wake the orchestrator for an idle notification that carries no submission, checkpoint, or blocker. If liveness must be recorded, expose it somewhere pollable so the orchestrator can read it when it chooses instead of being interrupted.
2. **Lower priority:** when a wake is genuinely required, batch teammate state changes. One wake carrying N state changes costs one context read instead of N.
