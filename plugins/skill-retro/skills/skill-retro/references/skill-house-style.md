# House style for a skill this pass writes

A retro that emits a skill nobody triggers, or a script that runs on one machine, has produced nothing.
These are the properties that decide whether the output survives contact with the next session.

## The description decides whether it ever runs

Frontmatter `description` is the only thing the model sees when deciding to load a skill. It has two
jobs, and both are required:

- **What it does**, concretely.
- **When to use it**, in the words someone would actually type.

```yaml
---
name: verify-worktree
description: >-
  Run the full verify sequence inside a worktree: git state check, npm ci at the right prefix, then the
  plugin's test suite. Use before submitting worktree work, when a verify fails with a missing prefix,
  or when checking whether a worktree is clean.
---
```

Write the trigger phrases as requests, not as a topic list. "Use for X" beats naming a category, because
the match happens against how the ask was phrased.

## The body is imperative, and every instruction earns its place

Write instructions, not description. And say **why each one matters**, because an instruction without a
reason is the first thing dropped when it is inconvenient.

Good:

> Run `npm ci` with `--prefix` pointing at the plugin directory, not from the worktree root. The root has
> no lockfile, so a bare `npm ci` installs nothing and the suite then fails on a missing dependency
> rather than on the actual change.

Bad:

> Run npm ci with the correct prefix.

The second one is true and useless: it does not say what "correct" means, and the moment it looks wrong
there is no reason to keep following it.

## Bundled scripts take real arguments

A script with a hardcoded absolute path works on exactly one machine, which is the same as not shipping
it. The parts that varied between runs in the transcript **are** the arguments; the miner lists them
under "Would become CLI arguments" precisely so they can be lifted straight into the signature.

- Parse arguments explicitly and fail with a clear message on an unknown flag.
- Default to `process.cwd()` or `CLAUDE_PROJECT_DIR`, never to a literal path.
- Reference the script from the skill as `"${CLAUDE_PLUGIN_ROOT}/bin/<name>.js"` so it resolves wherever
  the plugin is installed.
- Pass `windowsHide: true` on every `child_process` call. `plugins/test-support/windows-hide.js` fails
  the build otherwise, and without it every subprocess flashes a console window on Windows.

## Carry the fix and the reason to different places

When the finding was a fail-then-fix pair, they split:

- **The fix goes in the script**, where it cannot be forgotten.
- **The reason goes in the skill body**, where it survives the next person wondering why the flag is
  there and deciding to remove it.

Putting the reason only in a code comment loses it the moment someone reads the skill instead of the
source, and putting the fix only in prose guarantees it gets retyped wrong.

## Length

Keep it as short as it can be while still saying why. A skill that runs to several screens gets skimmed,
and a skimmed instruction is an unfollowed one. If it needs long background, that belongs in a
`references/` file the body points at, loaded only when it is needed.
