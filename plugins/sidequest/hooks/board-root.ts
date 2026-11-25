import type { BoardLocation } from './store'

const ORDINARY_GIT_FOLDER = /[\\/]\.git$/

const BARE_SETTING = /^\s*bare\s*=\s*true\s*$/im

// Every worktree of a bare repository reports the same common folder, and it has no `.git` folder to take a checkout
// from. A submodule's or a separate git folder's checkout has no `.git` folder either, and keeps the working folder.
export const mayBeBareRepository = (location: BoardLocation): location is BoardLocation & { gitCommonDir: string } =>
  location.gitCommonDir !== undefined && !ORDINARY_GIT_FOLDER.test(location.gitCommonDir)

// Windows spells one folder with either slash and in any letter case. Elsewhere a folder differing only in case is
// rare enough that reading it as the same one costs nothing worse than a line left unsaid.
const comparablePath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const withoutTrailingSlash = (root: string): string => root.replace(/[\\/]+$/, '')

const isInside = (folder: string, root: string): boolean => {
  const inner = comparablePath(folder)
  const outer = comparablePath(root)

  return inner === outer || inner.startsWith(`${outer}/`)
}

// Seen on 2026-11-20: a session that changed into another repository filed to the first one's board and the answer
// never said which. A linked worktree or a bare repository's worktree sits outside the board's root but inside the
// folder the board was found from, and says nothing.
export const otherBoardNote = (workingFolder: string | undefined, root: string, foundFrom: string | undefined): string | undefined => {
  const isAtHome = workingFolder === undefined || isInside(workingFolder, root) || isInside(workingFolder, foundFrom ?? root)

  return isAtHome ? undefined : `This went to the board at ${withoutTrailingSlash(root)}/.sidequest, the one this session started with: the working folder now, ${workingFolder}, is outside that project.`
}

// The common folder's own config says it is bare, so the board lives in that folder: the one place all the worktrees
// share, and one no worktree's file listing shows, so it needs no exclude line.
export const withBareRepositoryRoot = (location: BoardLocation, configText: string | undefined): BoardLocation =>
  mayBeBareRepository(location) && configText !== undefined && BARE_SETTING.test(configText) ? { ...location, root: location.gitCommonDir } : location
