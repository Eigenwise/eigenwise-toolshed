---
name: tidy
description: Use when worktrees pile up beside the checkout or the person asks to clean them up. Gives every linked worktree a verdict, safe or keep, and removes the safe ones.
---

# Tidy

Say which worktrees are finished and remove those, wherever they live and whoever made them. A worktree marked keep is never touched.

## Steps

1. **Look.** From the main checkout run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs"
   ```

   It prints one row per linked worktree: path, branch, uncommitted or untracked files, commits on no remote and not merged into the main checkout's branch, locked, last commit date, and the verdict. `safe` means nothing is uncommitted, nothing is only there, no rebase, merge or bisect is in progress, and it is not locked. Only there includes ignored files: one the main checkout lacks or holds with other content (a `.env`, a local database), or an ignored folder the main checkout does not have. Installed or built folders the main checkout has too still read safe. Anything else is `keep` with the reason.
2. **Show it.** Paste the table, then one line: how many can go, how many stay and why, in plain words (`12 can go. 5 stay: 3 have uncommitted files, 2 hold a commit that is on no remote.`). When the script prints a line starting `Safe, and named by a person`, show that line as it is before anything is removed: those folders or branches carry a name someone chose, not an agent's. Agent-named safe ones stay a count.
3. **Remove.** When the person asked for the cleanup, go on at once. Otherwise ask once whether to remove the safe ones and wait for the yes. Then run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" --remove-safe --named
   ```

   `--named` takes the person-named ones you showed in step 2 too; without it they stay. It re-reads every worktree, removes only the ones that are safe right now with a plain `git worktree remove` (never forced), and deletes a branch only when another branch or a remote holds its commits and `git branch -d` accepts it. Before a folder goes, any junction or symbolic link inside it that leads into the main checkout is taken away as a link, so the removal cannot delete files through it.
   The same run also lists local `worktree-agent-*` branches that have no worktree, safe when merged or empty and keep with the commit count otherwise. Hundreds of safe ones print as one count line with the keeps named, so show that line as it is and never list them one by one.
   To find worktree folders an older version left under the home directory that git no longer knows, pass the folder to look under (the older version's worktree folder, one folder per project inside it) as an argument to both commands. A folder is safe only when every file in it matches something the repository already holds; `--remove-safe` removes just those.
4. **Report** what it removed, which branches it kept and why, and what stays.

## Rules

- Never remove, force, unlock or clean a worktree marked keep, and never delete a branch `git branch -d` refuses. Its reason goes in the report; what to do with it is the person's call.
- Not while agents run. A worktree an agent just got has nothing in it yet and reads as safe. When the board shows running agents, wait until they return.
- `--json` prints the same report as JSON.
