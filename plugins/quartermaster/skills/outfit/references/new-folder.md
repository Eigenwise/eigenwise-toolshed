# A folder that is not a git repository yet

Observed on Claude Code 2.1.327 on 2026-11-18.

- Run `git init` before anything is written. Sidequest only keeps `.sidequest/` out of git when the board is created inside a repository, so a board made first goes into the first commit.
- A session reads whether it is inside a git repository once, at its start. After a `git init` and a commit made mid-session, every worktree agent still fails with `not in a git repository`, also after `/reload-plugins`. It works once the conversation continues in a new process.
- So the one stop here is a restart, not a reload. Ask the human to leave with `/exit`, come back with `claude --continue` in the same folder, and say when they are back. The restart loads freshly installed plugins too, so it is still one stop.
- A folder that was a repository when the session started needs only a commit before the first worktree agent, made at any point (`git commit --allow-empty` when there is nothing to commit yet). With no commit the agent fails with `no commit for HEAD`.
- After `/reload-plugins`, a freshly installed plugin's tools are listed from the next message, never in the reload's own turn.
