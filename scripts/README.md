# Repository scripts

The scripts here support repository maintenance and release work. The release engine lives in
`scripts/release/`; its README is the source for fragment, planning, cut, and guard commands.

Release publication is a manual, locked operation. Acquire the Sidequest publish lock before
running a real cut, preview with `node scripts/release/cut.mjs --dry-run`, and only publish with
the exact `git push --atomic` command printed by `cut.mjs`.

The release tests run with Node 22 and use throwaway local repositories for git behavior:

```bash
node --test scripts/release/test/*.test.mjs
```
