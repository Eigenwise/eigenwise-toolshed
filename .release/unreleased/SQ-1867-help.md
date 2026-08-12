---
ref: SQ-1867
title: CLI help no longer recommends heredocs to executors
bump: patch
plugins:
  - sidequest
---

`sidequest help` told everyone to pass multi-line `-d`/`-m` values with a heredoc, which the
harness refuses inside an isolated worktree, where executors do most of their work. It now
names `$'...\n...'` as the form that works everywhere and says plainly that a heredoc is
refused there.
