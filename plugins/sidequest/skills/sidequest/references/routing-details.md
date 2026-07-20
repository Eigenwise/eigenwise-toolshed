# Routing details: category routes and fallback resolution

Read this when you need to explain or debug routing. Category routing is primary: `list` and `ready`
return the live taxonomy plus each ticket's category projection, route, and resolved `exec` object.
Classify from the returned taxonomy, stamp the category before claim, then trust the resolved route.
Complexity-only tickets map to fixed category bands at read time. For model and effort guidance when
classification is genuinely ambiguous, see [routing-guide.md](routing-guide.md).

## Category routing

Categories are global board data. Each enabled row has a classifier description, default route, and
executor contract. Use the classifier description to select the narrowest matching category, not a
ticket title, urgency, requested model, or a copied local table. The route is live: changing a category
re-routes its open tickets on their next read.

A present valid category takes precedence over a stored complexity score. A missing category preserves
legacy complexity routing. An invalid, deleted, or disabled category resolves through the returned
general fallback projection with a warning, without rewriting the ticket. A ticket missing both fields
must be explicitly classified and updated before claim or dispatch.

The category projection includes its contract text. Inject that text verbatim into the executor prompt
with the ticket contract. The `exec` object remains the dispatch authority. Resolve the category route
when its model is available, then its category fallback, then the global fallback, then hardwired
Sonnet/high. If the read shows a degraded route, do nothing special: trust `exec` from that read.

## Legacy complexity bands

Complexity-only tickets map to categories at read time, without persisting the mapped category:

| Complexity | Category |
| --- | --- |
| 1–3 | `coding.easy` |
| 4–6 | `coding.normal` |
| 7–10 | `coding.hard` |

The mapped category's route and fallback chain provide the concrete model and effort. A ticket with
neither category nor complexity remains unclassified and is not dispatchable until classification.

## Worked example

A fresh read returns this ticket projection:

```json
{
  "ref": "SQ-12",
  "category": { "id": "coding.normal", "route": { "model": "codex-gpt-5-6-terra", "effort": "high" } },
  "model": "codex-gpt-5-6-terra",
  "effort": "high",
  "exec": { "agent": "sidequest-exec-dispatch-high", "model": null, "backend": "codex" }
}
```

Spawn the exact `exec.agent` with `model` omitted. A degraded route still uses the same dispatch
flow because the read's `exec` projection is authoritative. Another session adopts work by dispatching
the ticket again, which returns a fresh token and current spawn for the stable executor.

## Spawn parameters by route

The main skill's spawn rules, expanded. Every routed spawn goes through the native Agent tool with
the exact executor and spawn object a fresh `dispatch <ref>` returned.

- **Claude routes (`exec.model` non-null):** spawn `exec.agent` with `model: exec.model`,
  `mode: "bypassPermissions"`, and a unique `name`. Sidequest executors are unattended workers;
  omitting bypass sends their ordinary Bash approvals into the lead session. Never spawn a
  Claude-route executor without `model:` — an omitted model inherits the session model (usually the
  priciest route), silently defeating routing. The bundled PreToolUse hook injects or blocks as a
  backstop, but the spawn call must carry it.
- **Codex routes (`exec.model` null):** spawn the EXACT shared dispatch executor named by
  `exec.agent` (`sidequest-exec-dispatch-<effort>`) with `mode: "bypassPermissions"`, a unique
  `name`, and the `model` parameter OMITTED entirely — `exec.model` is null precisely so you leave
  it out. The def pins the virtual `claude-codex-auto`; the REAL model rides the spawn prompt's
  `[sidequest-route model=... effort=...]` marker, which the codex-gateway shim resolves per
  request — so the marker must reach the spawn prompt intact, and one spawn carries exactly one
  marker (never batch tickets stamped with different models). Passing ANY `model` value
  (`fable|opus|sonnet|haiku`) overrides the pin and silently runs Anthropic instead. Never
  substitute a generic `sidequest-exec-<effort>` agent for a Codex route — the board refuses its
  claim. Model provenance lives in the gateway route log, the subagent transcript, and
  `done --model`, never in the executor name.
- `<effort>` is the ticket's `effort` verbatim from the fresh read, never a level you judge fits
  better: the executor claims with `--effort <baked level>` and the board refuses the claim on a
  mismatch, bouncing the ticket back.
- **Haiku routes:** spawn the stable executor returned in `exec.agent` with
  `model: exec.model`, `mode: "bypassPermissions"`, and a unique `name`, like every other Claude
  route. A plain generic Agent is denied by the Sidequest gate.
- Worktree isolation: tickets with declared files carry `isolation: "worktree"` in `spawn`; pass it
  unchanged. `--shared-tree` / `{sharedTree:true}` is an escape hatch only for a task that depends
  on uncommitted local state, and its reason belongs in a ticket comment before spawning. A bounded
  documentation artifact may close with `done` only when it declares its artifact directory as file scope,
  was dispatched with shared-tree enabled, and includes this exact line:
  `Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.`
  Every other scoped ticket commits and submits.

## Re-scoring

```bash
sidequest update SQ-8 --complexity 5 --why "wider than scored: it also rewires the reader path"
```

A changed score must arrive with a fresh `--why`; an unmotivated re-score is rejected.
