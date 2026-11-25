import type { EngineInterface } from 'claude-code'

import { foldersWorthWalking } from './interrupted-work'
import type { WithoutGit } from './own-worktree'
import type { BoardLocation } from './store'

type Engine = Pick<EngineInterface, 'fs'>

const MOST_FOLDERS_LOOKED_INTO = 100

const holdsGitEntry = (entries: readonly { name: string }[]): boolean => entries.some(entry => entry.name === '.git')

export async function repositoryFoldersUnder($: Engine, folder: string): Promise<string[]> {
  const names = foldersWorthWalking(await $.fs.list(folder).catch(() => [])).slice(0, MOST_FOLDERS_LOOKED_INTO)
  const inside = await Promise.all(names.map(name => $.fs.list(`${folder.replace(/[\\/]+$/, '')}/${name}`).catch(() => [])))

  return names.filter((_, index) => holdsGitEntry(inside[index] ?? []))
}

export async function withoutGitFor($: Engine, location: BoardLocation): Promise<WithoutGit | undefined> {
  if (location.gitCommonDir !== undefined) return undefined

  return { folder: location.root, repositoryFolders: await repositoryFoldersUnder($, location.root) }
}
