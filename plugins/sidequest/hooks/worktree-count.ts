import type { FsEntry } from 'claude-code'

const MANY_WORKTREES = 5

export const TIDY_REQUEST_LINE = 'Clean up the finished worktrees (/sidequest:tidy).'

// git keeps one folder per linked worktree under its common folder, wherever the worktree itself lives.
export const worktreesFolderOf = (gitCommonDir: string): string => `${gitCommonDir}/worktrees`

export const linkedWorktreeCount = (entries: readonly FsEntry[]): number => entries.filter(entry => entry.kind === 'dir').length

export const hasManyWorktrees = (count: number): boolean => count >= MANY_WORKTREES

export const worktreeToast = (count: number): string =>
  `${count} worktrees sit beside this checkout. The tidy skill (/sidequest:tidy) says which are finished and removes those on your yes.`

export const worktreeRowText = (count: number): string => `${count} leftover git worktrees from finished work`
