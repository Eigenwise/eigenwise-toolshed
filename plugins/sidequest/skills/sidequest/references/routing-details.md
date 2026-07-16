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
flow because the read's `exec` projection is authoritative.

## Re-scoring

```bash
sidequest update SQ-8 --complexity 5 --why "wider than scored: it also rewires the reader path"
```

A changed score must arrive with a fresh `--why`; an unmotivated re-score is rejected.
