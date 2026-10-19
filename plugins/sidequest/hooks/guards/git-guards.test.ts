import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { REPO_FACTS_ARGS } from './git-guards.js'
import { slugify } from './snapshot.js'

// The git guards moved from three command hooks into the module (SQ-3750). Each deny text the command
// hooks' node tests asserted is asserted here, against a faked file system, git and dispatch snapshot.

const HOME = 'C:\\sq'
const PROJECT = 'C:\\proj'
const SESSION = 'session-1'

type Repo = { root: string; commonDir: string; dirty?: string[] }
type Row = { ref: string; agentId: string | null; worktree: string | null; sharedTree: boolean; state: string; claimSessionId?: string }
type Git = (argv: readonly string[], cwd: string) => { exitCode: number; stdout: string } | undefined

// A POSIX engine treats a Windows path as relative and resolves it under its cwd before the hook sees it;
// drop that prefix so the faked world matches on every platform.
const key = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[a-z]:\/)/i, '').replace(/\/+$/, '').toLowerCase()

async function worktreeRoot(): Promise<string> {
  return `${HOME}\\worktrees\\${await slugify(PROJECT, true)}`
}

async function projectFolder(path: string): Promise<string> {
  return `${HOME}/projects/${await slugify(path, true)}`
}

type World = { cwd: string; rows?: Row[]; repos: Repo[]; registered?: string[]; files?: Record<string, string>; git?: Git; integrationBranch?: string }

async function world(on: On, setup: World): Promise<string[][]> {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\kenny', SIDEQUEST_HOME: HOME })
  const files = new Map<string, string>(Object.entries(setup.files ?? {}).map(([path, text]) => [key(path), text]))
  files.set(key(`${PROJECT}/.git/HEAD`), 'ref: refs/heads/main\n')
  files.set(key(`${await projectFolder(PROJECT)}/dispatch-snapshot.json`), JSON.stringify({
    v: 1,
    routed: true,
    dispatches: (setup.rows ?? []).map((row) => ({
      sessionId: SESSION, claimSessionId: row.claimSessionId ?? null, agentName: null, executor: 'sidequest-exec-high', readonly: false, deniedTools: [], ...row,
    })),
  }))
  const directories = new Set(setup.repos.map((repo) => key(repo.root)))
  for (const path of setup.registered ?? []) directories.add(key(`${await projectFolder(path)}/tickets`))
  const runs: string[][] = []
  on('session.cwd', () => ({ value: setup.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('fs.exists', ($, e) => ({ value: directories.has(key(e.path)) || files.has(key(e.path)) }))
  on('fs.read', ($, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('process.run', ($, e) => {
    const cwd = e.init?.cwd ?? setup.cwd
    runs.push([...e.argv])
    const repo = setup.repos.find((candidate) => key(candidate.root) === key(cwd))
    const answer = setup.git?.(e.argv, cwd) ?? fakeGit(e.argv, repo, setup.integrationBranch)
    return { value: { stderr: '', ...answer } }
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  return runs
}

function fakeGit(argv: readonly string[], repo: Repo | undefined, integrationBranch = 'main'): { exitCode: number; stdout: string } {
  if (argv[0] === 'node') return { exitCode: 0, stdout: JSON.stringify({ integrationBranch }) }
  if (!repo) return { exitCode: 128, stdout: '' }
  const answers: Record<string, string> = {
    [REPO_FACTS_ARGS.join(' ')]: `${repo.root.replace(/\\/g, '/')}\n${repo.commonDir.replace(/\\/g, '/')}\n`,
    'status --porcelain': (repo.dirty ?? []).map((line) => `${line}\n`).join(''),
    'branch --show-current': 'main\n',
    'remote get-url upstream': 'https://example.invalid/upstream.git\n',
  }
  const stdout = answers[argv.slice(1).join(' ')]
  return stdout === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout }
}

async function bash($: EngineInterface, command: string, agentId?: string) {
  return $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
}

function wholeTreeWrites(target: string): string[] {
  const shellPath = target.replace(/\\/g, '/')
  return [
    `git -C "${shellPath}" restore --source HEAD --worktree -- .`,
    `git -C "${shellPath}" checkout -- .`,
    `git -C "${shellPath}" reset --hard HEAD`,
  ]
}

const projectRepo: Repo = { root: PROJECT, commonDir: `${PROJECT}\\.git` }
const CLONE = `${HOME}\\projects\\proj-x\\verification\\SQ-3436\\pr450`

test('destructive git: an evidence clone under the ticket verification directory is not the shared checkout', async ($, on) => {
  const clone: Repo = { root: CLONE, commonDir: `${CLONE}\\.git`, dirty: [' D README.md'] }
  await world(on, { cwd: PROJECT, repos: [projectRepo, clone], registered: [PROJECT] })
  for (const command of wholeTreeWrites(CLONE)) expect(await bash($, command)).toMatchObject({ text: 'ran' })
})

test('destructive git: the registered root with dirty work stays refused, a clean or unregistered one is admitted', async ($, on) => {
  const longRoot = `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\sq-sidequest-full-suite-abc\\${'sq-destructive-repo-'.padEnd(40, '-')}`
  const dirty: Repo = { root: longRoot, commonDir: `${longRoot}\\.git`, dirty: ['?? executor-work.txt'] }
  const unregistered: Repo = { root: 'C:\\scratch', commonDir: 'C:\\scratch\\.git', dirty: ['?? scratch.txt'] }
  await world(on, { cwd: longRoot, repos: [projectRepo, dirty, unregistered, { ...projectRepo, root: 'C:\\clean', commonDir: 'C:\\clean\\.git' }], registered: [longRoot, 'C:\\clean'] })

  const denied = await bash($, 'git reset --hard origin/main')
  const reason = String(Reflect.get(denied, 'deny'))
  expect(reason).toContain('board-registered project root; your evidence clone is not one')
  expect(reason).toContain('executor-work.txt')
  expect(reason).toContain('git stash push -u -m "sidequest recovery"')
  expect(reason).toContain(`sidequest recover-shared --project "${longRoot}" --stash <stash@{n}> --yes`)
  expect(reason).toEndWith('That exact recovery action verifies the stash before it runs `git reset --hard && git clean -fd`.')
  expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(768)

  expect(await bash($, 'git checkout -- README.md')).toMatchObject({ text: 'ran' })
  expect(await bash($, 'cd C:/clean && git reset --hard HEAD')).toMatchObject({ text: 'ran' })
  expect(await bash($, 'git -C "C:/scratch" reset --hard HEAD')).toMatchObject({ text: 'ran' })
  const elsewhere = await bash($, `cd C:/scratch; git -C "${longRoot.replace(/\\/g, '/')}" clean -fd`)
  expect(Reflect.get(elsewhere, 'deny')).toContain('refusing git clean -f')
})

test('destructive git ignores heredoc prose but refuses an executable publication command', async ($, on) => {
  await world(on, { cwd: PROJECT, repos: [projectRepo], registered: [PROJECT], integrationBranch: 'dev' })
  const proseOnly = `git commit -F - <<'MESSAGE'\ngit push --force origin main\ngit reset --hard and rm -rf remain guarded in this security note\nMESSAGE`
  expect(await bash($, proseOnly)).toMatchObject({ text: 'ran' })
  const executablePush = `git commit -F - <<'MESSAGE'\nsecurity note: git push --force remains guarded\nMESSAGE\ngit push --force origin HEAD:main`
  expect(Reflect.get(await bash($, executablePush), 'deny')).toMatch(/publish lock/)
})

const PUBLISHING = [
  'git tag v3.208.0',
  'git tag -a v3.208.0 -m release',
  'git push origin main',
  'git push origin HEAD:main',
  'git push --force origin HEAD:main',
  'git push origin +main',
  'git push origin main:',
  'git push upstream HEAD:main',
  'git push origin --tags',
  'git push origin dev --follow-tags',
]

test('published-branch pushes and manual tags need the current session publish lock', async ($, on) => {
  await world(on, { cwd: PROJECT, repos: [projectRepo], registered: [PROJECT], integrationBranch: 'dev' })
  for (const command of PUBLISHING) expect(Reflect.get(await bash($, command), 'deny')).toMatch(/local early warning/)
  for (const command of ['git status', 'git fetch origin', 'git tag --list', 'git push origin dev', 'git push upstream HEAD:dev', 'echo "; git tag v3.208.0"']) {
    expect(await bash($, command)).toMatchObject({ text: 'ran' })
  }
})

test('the publish lock admits its own session and repo, and a Git Bash /c/ path resolves to the locked repo', async ($, on) => {
  const other: Repo = { root: 'C:\\other', commonDir: 'C:\\other\\.git' }
  await world(on, {
    cwd: PROJECT, repos: [projectRepo, other], registered: [PROJECT], integrationBranch: 'dev',
    files: { [`${PROJECT}\\.git\\sidequest-publish.lock`]: JSON.stringify({ transient: true, sessionId: SESSION, repo: PROJECT }) },
  })
  const crossRepo = await bash($, `git -C "${PROJECT}" status; git -C "C:/other" tag v3.208.0`)
  expect(Reflect.get(crossRepo, 'deny')).toMatch(/entire shell invocation/)
  for (const command of PUBLISHING) expect(await bash($, command)).toMatchObject({ text: 'ran' })
  expect(await bash($, 'cd /c/proj && git tag -d v3.208.0')).toMatchObject({ text: 'ran' })
})

test('destructive git fails closed when its check cannot run', async ($, on) => {
  await world(on, { cwd: PROJECT, repos: [projectRepo], registered: [PROJECT], git: () => { throw new Error('git is not installed') } })
  expect(await bash($, 'git reset --hard HEAD')).toMatchObject({ deny: 'sidequest: destructive git guard could not run; refusing git reset --hard HEAD' })
  expect(await bash($, 'git status')).toMatchObject({ text: 'ran' })
})

async function isolatedWorld(on: On) {
  const own = `${await worktreeRoot()}\\agent-own`
  const other = `${await worktreeRoot()}\\agent-other`
  const runs = await world(on, {
    cwd: own,
    rows: [{ ref: 'SQ-1', agentId: 'agent-own-id', worktree: own, sharedTree: false, state: 'claimed' }],
    repos: [projectRepo, { root: own, commonDir: projectRepo.commonDir }, { root: other, commonDir: projectRepo.commonDir }, { root: CLONE, commonDir: `${CLONE}\\.git` }],
    registered: [PROJECT],
    files: { [`${own}\\.git`]: `gitdir: ${PROJECT}\\.git\\worktrees\\agent-own\n` },
  })
  return { own, other, runs }
}

test('an isolated executor mutates its evidence clone and own worktree, never the root or another executor\'s worktree', async ($, on) => {
  const { own, other } = await isolatedWorld(on)
  for (const command of [...wholeTreeWrites(CLONE), ...wholeTreeWrites(own), 'git checkout -- .']) {
    expect(await bash($, command, 'agent-own-id')).toMatchObject({ text: 'ran' })
  }
  for (const target of [PROJECT, other]) {
    for (const command of wholeTreeWrites(target)) {
      const reason = Reflect.get(await bash($, command, 'agent-own-id'), 'deny')
      expect(reason).toBe(`sidequest: refusing a mutating git command against the shared checkout (${target}) from an isolated worktree. The shared checkout means the project's registered root and every other executor's worktree; a clone you created under your ticket's verification directory or scratchpad is not it and stays writable. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree.`)
    }
  }
  expect(await bash($, `git -C "${PROJECT.replace(/\\/g, '/')}" log --oneline`, 'agent-own-id')).toMatchObject({ text: 'ran' })
  expect(await bash($, `git -C "${PROJECT}" reset --hard HEAD`, 'integrator-subagent')).toMatchObject({ text: 'ran' })
})

test('the sync-check command the briefing prints passes every git guard for an isolated executor', async ($, on) => {
  const { runs } = await isolatedWorld(on)
  const command = `node "C:\\Users\\kenny\\.claude\\sidequest\\sidequest-launcher.js" sync-check ${'a'.repeat(40)}`
  expect(await bash($, command, 'agent-own-id')).toMatchObject({ text: 'ran' })
  expect(runs).toEqual([])
})

test('a 50-call executor turn spawns one git process: a rev-parse for its one directory', async ($, on) => {
  const { runs } = await isolatedWorld(on)
  const commands = ['ls', 'git status', 'git diff', 'npm test', 'git log --oneline', 'git add src/a.ts', 'cat a.ts', 'git commit -m wip', 'node build.js', 'git show HEAD']
  for (let call = 0; call < 50; call += 1) await bash($, commands[call % commands.length]!, 'agent-own-id')
  expect(runs).toEqual([['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']])
})

test('a shared-tree claim cannot raw-commit in the shared checkout', async ($, on) => {
  await world(on, {
    cwd: PROJECT,
    rows: [{ ref: 'SQ-77', agentId: 'shared-commit-agent', worktree: null, sharedTree: true, state: 'claimed' }],
    repos: [projectRepo],
    registered: [PROJECT],
  })
  expect(await bash($, 'git commit -m "bypass"', 'shared-commit-agent')).toMatchObject({
    deny: 'sidequest: refusing raw git commit for SQ-77 in the shared checkout.\nUse mcp__plugin_sidequest_board__commit so Sidequest stages and commits only the approved ticket scope.\nIf the path needs approval first, request scope before committing.',
  })
  expect(await bash($, 'git -c user.name=x commit -m "bypass"', 'shared-commit-agent')).toMatchObject({ deny: expect.stringContaining('SQ-77') })
  expect(await bash($, 'git commit -m "bypass"', 'unrelated-agent')).toMatchObject({ text: 'ran' })
  expect(await bash($, 'git add README.md', 'shared-commit-agent')).toMatchObject({ text: 'ran' })
})

test('the shared-checkout guard fails open when git cannot run', async ($, on) => {
  await world(on, {
    cwd: PROJECT,
    rows: [{ ref: 'SQ-77', agentId: 'shared-commit-agent', worktree: null, sharedTree: true, state: 'claimed' }],
    repos: [projectRepo],
    git: () => { throw new Error('git is not installed') },
  })
  expect(await bash($, 'git commit -m wip', 'shared-commit-agent')).toMatchObject({ text: 'ran' })
})
