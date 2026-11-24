# Toolshed: project rules

Read `ARCHITECTURE.md` (the contract) and `SCOPE.md` (the admission bar) before changing anything. They're short.

## Hard rules

- **No command hooks on `PreToolUse`, `PostToolUse` or `UserPromptSubmit`.** In-process hooks modules only. Zero processes per tool call.
- **Subagents never write board or proposal state.** They return a result. The main session writes.
- **Every gating hook has a `.catch` and fails open.** A broken hook of ours must never stop someone's work.
- **A new guard, gate or config key needs an observed v2 failure behind it.** Otherwise write the note in `.out-of-scope/` and move on.
- **Nothing may depend on a rule, memory or setting in someone's home directory.** If the product needs it, it ships in the plugin or is written into the project with approval.
- **Plugins stay standalone.** No `dependencies` between them. Cooperate through files or published `$.state` keys, and handle the other being absent.
- **No named consumers.** No person, project, company or language special cases in code, tickets or docs.

## Code

- Pure logic in plain `.ts` files that take and return values. `register.tsx` only wires. Keep every function's cyclomatic complexity below 6.
- Names say the domain thing, never the pattern. No abbreviations.
- Comments only for a why the code can't carry.
- No `any`, no bare `@ts-ignore`, no silent `as` casts.

## Checking a change

```bash
node scripts/check.mjs
```

Runs `claude plugin validate` and `claude plugin test` for every plugin plus the repo's structural tests. A change isn't done until that's green. Mods are early access in Claude Code, so trust the types in `.claude-plugin/types/` and the validator over memory.

## Docs

- Agent-facing text (tool descriptions, skill bodies, agent definitions, refusal strings) is the contract. It changes in the same commit as the behaviour.
- Each plugin has one prose page: its `README.md`.
- `shared/` holds text used by more than one plugin. Edit it there and run `node scripts/sync-shared.mjs`. Never edit the copies.

## Voice

Plain and spoken. Lead with the useful thing. No em dashes. No marketing words.
