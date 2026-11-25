import { expect, test } from 'claude-code/testing'
import { excludeWorktreesFromGit, withExcludeEntry } from './store'

const ROOT = '/repo'
const EXCLUDE_PATH = `${ROOT}/.git/info/exclude`
const LOCATION = { root: ROOT, gitCommonDir: `${ROOT}/.git` }
const NOTICE = 'Added .claude/worktrees/ to .git/info/exclude so the folders agents work in stay out of git status.'

type Repository = { writeIsRefused?: boolean }
type EngineForExclusion = Parameters<typeof excludeWorktreesFromGit>[0]

// The test engine has no fs or process, so the function runs against the calls it makes. The cast is the only gap
// between this stand-in and the real engine.
const engineOver = (files: Map<string, string>, gitCalls: string[], repository: Repository = {}): EngineForExclusion =>
  ({
    fs: {
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT ${path}`)

        return text
      },
      write: async (path: string, text: string) => {
        if (repository.writeIsRefused) throw new Error(`EACCES ${path}`)
        files.set(path, text)
      },
    },
    process: {
      run: async (argv: string[]) => {
        gitCalls.push(argv[1] ?? '')

        return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  }) as unknown as EngineForExclusion

test('the worktrees folder is added to the exclude file and the notice says so', async () => {
  const files = new Map([[EXCLUDE_PATH, '# kept\n']])

  expect(await excludeWorktreesFromGit(engineOver(files, []), LOCATION)).toBe(NOTICE)
  expect(files.get(EXCLUDE_PATH)).toBe('# kept\n.claude/worktrees/\n')
})

test('a folder already listed says nothing and starts no process', async () => {
  const files = new Map([[EXCLUDE_PATH, '.sidequest/\n/.claude/worktrees\n']])
  const gitCalls: string[] = []

  expect(await excludeWorktreesFromGit(engineOver(files, gitCalls), LOCATION)).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('a folder the root .gitignore already lists is left alone and starts no process', async () => {
  const files = new Map([
    [EXCLUDE_PATH, ''],
    [`${ROOT}/.gitignore`, 'node_modules/\n.claude/worktrees/\n'],
  ])
  const gitCalls: string[] = []

  expect(await excludeWorktreesFromGit(engineOver(files, gitCalls), LOCATION)).toBeUndefined()
  expect(files.get(EXCLUDE_PATH)).toBe('')
  expect(gitCalls).toEqual([])
})

test('a folder outside a git repository says nothing and starts no process', async () => {
  const gitCalls: string[] = []

  expect(await excludeWorktreesFromGit(engineOver(new Map(), gitCalls), { root: ROOT })).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('a failing write returns nothing instead of throwing', async () => {
  const files = new Map([[EXCLUDE_PATH, '']])

  expect(await excludeWorktreesFromGit(engineOver(files, [], { writeIsRefused: true }), LOCATION)).toBeUndefined()
  expect(files.get(EXCLUDE_PATH)).toBe('')
})

test('an exclude file without a final newline still gets the entry on its own line', () => {
  expect(withExcludeEntry('*.log', { folder: '.claude/worktrees', notice: '' })).toBe('*.log\n.claude/worktrees/\n')
})
