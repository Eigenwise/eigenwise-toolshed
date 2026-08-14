# Default category taxonomy

Sidequest ships four routing profiles: Coding, Creative music, Research, and Writing. Their defaults always work in a Sidequest-only install. Every seed route begins as a native Claude route.

## Optional Model Gateway routes

A ready Model Gateway catalog can replace a Coding seed route only when it advertises the exact GPT slug below. Missing, empty, unreadable, stale, or unready catalogs leave the native route in place.

| Coding category | Native route | Exact optional Gateway route |
| --- | --- | --- |
| Codebase exploration | `sonnet` / `high` | `codex-gpt-5-6-luna` / `high` |
| Implementation-grounded explanation | `sonnet` / `high` | `codex-gpt-5-6-luna` / `high` |
| General fallback | `sonnet` / `high` | `codex-gpt-5-6-luna` / `high` |
| Review or audit | `sonnet` / `high` | `codex-gpt-5-6-terra` / `high` |
| Standard coding | `sonnet` / `high` | `codex-gpt-5-6-terra` / `high` |
| Straightforward change | `sonnet` / `medium` | `codex-gpt-5-6-terra` / `medium` |
| Behavior verification | `sonnet` / `high` | `codex-gpt-5-6-luna` / `high` |
| Interaction design and implementation | `sonnet` / `high` | `codex-gpt-5-6-terra` / `high` |

The mapping is explicit. Sidequest never substitutes a different GPT model when the advertised one is absent.

## Seed migration and dispatches

An untouched shipped profile updates when the available provider capability changes, so its displayed and dispatched category route stays valid. User-created or edited profiles, plus project category overrides and detaches, keep their configured routes.

A prepared, launched, or claimed dispatch keeps its pinned executor route. If its Gateway provider disappears, the dispatch fails closed rather than switching to Claude or another GPT model.
