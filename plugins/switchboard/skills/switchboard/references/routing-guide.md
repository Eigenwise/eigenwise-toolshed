# Routing guide: category classification and dispatch

Switchboard is a category router. It does not estimate a task on a C1-C10 scale. The effective
category set is the only classifier, and each category carries an executor contract as well as a
route.

## Start with the effective taxonomy

Always fetch the effective categories for the project you are about to work in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" category list --project "$PWD" --json
```

The response includes shipped categories plus user and project overlays. Its enabled `description`
fields are the classifier descriptions. Read them all, select exactly one matching category, and
carry its `contract` to the executor. Do not classify from this document's examples when the live
list disagrees, and do not combine two categories into an invented hybrid.

`general` is the safe fallback when the task is underspecified or no specific category fits. It is a
prompt to clarify or inspect just enough to reclassify, not permission for broad work.

## Boundary cues in the shipped taxonomy

These are cues, not a replacement for the effective list:

- **mechanical**: explicit, tightly bounded, reversible change with no diagnosis or design choice.
- **coding.easy**: a code change whose correct edit is obvious from an existing verbatim pattern.
- **coding.normal**: a clear code destination that still needs conventional local engineering
  judgment or coordinated edits.
- **coding.hard**: an irreversible or adversarially important change without a clearly correct
  existing pattern, especially API, security, data-integrity, or architecture tradeoffs.
- **debugging**: an observed defect or unknown runtime cause. Reproduce and narrow before fixing.
- **testing**: intended behavior is known and the work is focused verification, test repair, or test
  addition. Unknown failure cause is debugging instead.
- **spike-investigation**: answer a system-specific unknown by building or running something, then
  recommend with evidence and remaining uncertainty.
- **codebase-exploration**: map existing code without editing or recommending a new design.
- **review-audit** and **security-audit**: evidence-backed findings, not an unsolicited rewrite;
  security-audit is specifically vulnerability-focused.
- **ui-frontend** and **dataviz**: user-facing visual work needs rendered-output validation.
- **docs-writing**: supplied facts and clear audience; source-dependent questions belong in
  **web-research** or **deep-research**.
- **architecture-design**: system boundaries or cross-cutting direction with material tradeoffs.

Category descriptions may be customized. The live description wins over these cues.

## Contract-v1 resolution

Resolve the chosen ID rather than reading its configured route yourself:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/switchboard.js" resolve <category-id> --project "$PWD" --json
```

This is routing contract v1. Accept a result only when it has `contractVersion: 1` and
`status: "routed"`. It returns:

- `category.id` and `category.contract`: the specific execution standard
- `route`: the selected route and its source, including any fallback selection
- `dispatch`: the provider-neutral spawn instruction
- `attempts` and `warnings`: why configured routes were skipped

Fallback resolution is intentional policy. Use its returned category contract and dispatch exactly
as returned. If the status is `unrouted`, the version is unsupported, or warnings make the task
unsafe to route, report that result instead of guessing another model.

For a direct contract consumer, submit `{ contractVersion: 1, categoryId }`; do not send a numeric
complexity or pre-selected model.

## Provider-neutral dispatch

`route.model` identifies the resolved route. `dispatch` tells the spawning consumer how to launch it:

| `dispatch.kind` | Spawn model | Prompt requirement |
| --- | --- | --- |
| `native` | `dispatch.spawnModel` | No routing marker. |
| `gateway-marker` | `dispatch.spawnModel` | Begin the prompt with `dispatch.marker` unchanged. |

Gateway dispatch lets the provider resolve the concrete backend without the skill knowing its
provider-specific spawn mechanics. Never use the gateway route's model ID as the Agent `model:`.

## Stable executors

The executor name is determined only by `route.effort`:

```text
switchboard-exec-low
switchboard-exec-medium
switchboard-exec-high
switchboard-exec-xhigh
switchboard-exec-max
```

Each has fixed frontmatter effort. Pass the complete task packet, including `category.contract` and
an exact verification command or reproduction. An unnamed or generic worker loses that effort
contract. If a result has null or unknown effort, do not make up an executor or borrow a nearby
one. Surface the incompatible route configuration.

## Why categories replace scoring

A numeric score encouraged agents to reason from a vague abstract difficulty scale, then select a
model before reading the policy that defines the work. Categories make the meaningful distinction
first: diagnosis versus verification, exploration versus implementation, reversible mechanical work
versus hard design tradeoffs, and source-backed research versus repository investigation. The route
and executor contract then follow from that explicit task shape.

The old numeric commands remain for manual compatibility only. New Switchboard orchestration must
not call them.
