---
ref: SQ-22
title: worktrees sweep classifies a finished worktree dirty because installedDependencyCacheFile refuses in-tree node_modules/.bin symlinks
bump: patch
plugins: [sidequest]
commit: 185b561735f9711633118d4e4b393897a9b67195
---

The sweep's at-risk classifier now judges an ignored file under node_modules by where its path components resolve: a symlink segment whose target stays inside the worktree is a plain component, so the node_modules/.bin links an executor's install wrote no longer make a finished worktree read as dirty and park it as untracked_quarantined for the 14-day retention instead of reclaiming it as ticket_done. A link under node_modules that escapes the tree, a dangling or unreadable entry, a directory entry, and a nested repository still count as data and still travel into quarantine.
