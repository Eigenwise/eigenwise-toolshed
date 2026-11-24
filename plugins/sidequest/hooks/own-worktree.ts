import type { Ticket } from './tickets'

// Present when the board's folder is not a git repository: the folder, and the folders directly under it that are.
export type WithoutGit = { folder: string; repositoryFolders: readonly string[] }

const escapedForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isWholeWordIn = (text: string, folderName: string): boolean =>
  new RegExp(`(^|[^\\w.-])${escapedForPattern(folderName)}($|[^\\w.-])`).test(text)

export const namesARepository = (ticket: Pick<Ticket, 'title' | 'what' | 'doneWhen'>, repositoryFolders: readonly string[]): boolean => {
  const text = [ticket.title, ticket.what, ticket.doneWhen].join('\n')

  return repositoryFolders.some(folderName => isWholeWordIn(text, folderName))
}

export const ownWorktreeSection = (boardFolder: string): string[] => [
  [
    '## No git here',
    `The board's folder, ${boardFolder}, is not a git repository, so the host made no worktree for you. The work is in the repository this ticket names, under that folder.`,
    "There, make your own worktree on a new branch: `git -C <repository> worktree add <a folder under that repository's .claude/worktrees> -b <branch>`. Work only inside it. Never switch branches or commit in the person's checkout. Report the repository, the worktree folder and the branch in your result.",
  ].join('\n'),
]

const ADD_THE_REPOSITORY =
  " The ticket's text names no repository folder. Add it to the ticket with the ticket tool and call start again before the agent is started; no agent is on the ticket yet, so the repeat note on that second start can be ignored."

export const noGitAnswerNote = (isRepositoryNamed: boolean): string =>
  `The board's folder has no git, so the host cannot make a worktree from here. This start asks for no isolation, and its brief tells the worker to make its own worktree in the repository the ticket's work is in.${isRepositoryNamed ? '' : ADD_THE_REPOSITORY}`
