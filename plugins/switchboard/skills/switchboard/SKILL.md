---
name: switchboard
description: >-
  Category-based routing for delegated work. Use proactively before handing a discrete task to a
  subagent: classify it against the effective category descriptions, resolve its route, and dispatch
  the stable executor the route requires.
---

# switchboard

## What it does

Switchboard routes a delegated task by **category**, not a numeric difficulty score. The effective
category descriptions are the classifier. Pick exactly one category, resolve it through routing
contract v1, then dispatch the resulting provider-neutral route to the matching stable executor.

The category supplies two things that must travel with the task:

- its route, including model, effort, fallback result, and provider-neutral dispatch instructions
- its executor contract, which defines the category-specific standard for the work

## Decision procedure

1. List the effective taxonomy for the target project before classifying:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" category list --project "$PWD" --json
   ```

   Read every enabled category's `id`, `name`, `description`, and `contract`. This response is the
   complete effective classifier, including user and project overrides. Do not use a memorized or
   shipped-only category list.

2. Choose **exactly one** enabled category by matching the task to its `description`. State the
   category ID and a one-line reason tied to that description before spawning. Do not blend
   categories, score the task, or choose a route by intuition. Use `general` only when no specific
   description fits or the task is genuinely underspecified.

3. Resolve the chosen category through contract v1:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" resolve <category-id> --project "$PWD" --json
   ```

   The result must have `contractVersion: 1` and `status: "routed"`. Read the resolved
   `category.contract`, `route`, `dispatch`, `attempts`, and `warnings`. A fallback route is still
   authoritative when resolution selected it. If the result is unrouted, malformed, or has an
   unsupported contract version, do not spawn. Report the warnings and stop or clarify the task.

4. Dispatch from `dispatch`, never from `route.model` directly:

   - `kind: "native"`: pass `model: dispatch.spawnModel` to the agent spawn.
   - `kind: "gateway-marker"`: pass `model: dispatch.spawnModel` and put `dispatch.marker` as the
     first line of the executor prompt, byte-for-byte. Do not turn the gateway model into a direct
     `model:` value.

5. Spawn `subagent_type: switchboard-exec-<route.effort>` with a unique lowercase-hyphen `name`.
   These five stable executors pin their effort in frontmatter: `low`, `medium`, `high`, `xhigh`,
   and `max`. Re-resolve each independent task before spawning it. A route without one of those
   effort values cannot use this executor protocol, so report it instead of substituting a generic
   agent or silently changing effort.

6. Give the executor a complete packet:

   ```text
   <dispatch.marker when present>
   Task: <the concrete delegated task>
   Category: <resolved category id>
   Category contract: <resolved category.contract>
   Verification: <exact check or reproduction to run>
   ```

   The category contract is part of the task, not optional background. Keep the work bounded to the
   task, but require the executor to satisfy that contract and run the supplied verification.

## Spawn shape

```js
Agent({
  subagent_type: `switchboard-exec-${resolution.route.effort}`,
  model: resolution.dispatch.spawnModel,
  name: 'exec-unique-task-name',
  prompt: [
    resolution.dispatch.kind === 'gateway-marker' ? resolution.dispatch.marker : null,
    `Task: ${task}`,
    `Category: ${resolution.category.id}`,
    `Category contract: ${resolution.category.contract}`,
    `Verification: ${verify}`,
  ].filter(Boolean).join('\n'),
})
```

The marker is only for `gateway-marker` dispatch. Native dispatches have no marker. Do not put a
raw provider-specific model ID in the prompt, override the resolved effort, or use an unnamed or
generic worker.

## Parallel work

Classify and resolve each independent task separately, then spawn the resulting named executors in
one message. A shared category does not make two tasks one route. For coupled work, keep it in one
packet only when the category contract and verification need one executor to own the whole result.

## Legacy compatibility

`models`, `bias`, `route <complexity>`, `enable`, `disable`, and `routing` remain available only for
manual compatibility. This skill never calls them and never uses C1-C10 scoring.

## CLI reference

Invoke as `node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" <cmd>`.

- `category list --project <path> [--json]` — effective categories and classifier descriptions.
- `category show <id> --project <path> [--json]` — one effective category.
- `resolve <id> --project <path> [--json]` — contract-v1 route resolution with attempts and warnings.
- `available --project <path> [--json]` — configured model catalog and effort caps.
- `contract [--json]` — contract registry breadcrumb.
- `doctor --project <path> [--json]` — configuration and catalog checks.

See [references/routing-guide.md](references/routing-guide.md) when a category boundary is unclear.
