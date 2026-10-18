import type { EngineInterface } from 'claude-code'

import type { SnapshotRow } from './context-guards.js'
import {
  branchName, destructiveMatch, gitInvocations, invocationDirectory, isTagRef, pushesEverything, samePath, shellTokens, tagAction,
} from './git-command.js'
import type { GitInvocation } from './git-command.js'
import { withoutHereDocBodies } from './heredocs.js'
import { caller, machine, projectRoot, registeredRoot, sidequestHome, slugify } from './snapshot.js'
import { resolveAbsolute } from './text-guards.js'
import type { Machine } from './text-guards.js'
import type { RepoFacts } from '../../types/index.js'

// git runs only once the command text already names a destructive, publishing or mutating invocation, and
// the repository behind each directory is asked once per session.

const REPO_ROOTS = { plugin: 'sidequest', key: 'repoRoot' } as const
const PROCESS_TIMEOUT_MS = 10_000
export const REPO_FACTS_ARGS = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']
const MUTATING_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'tag',
  'update-ref', 'worktree',
])

type Shell = { command: string; cwd: string; host: Machine }
type Repo = { root: string; commonDir: string | null }
type Upstream = { remote: string; branch: string }
type LockHolder = { sessionId?: unknown; repo?: unknown }

async function git($: EngineInterface, directory: string, args: string[]): Promise<string> {
  const ran = await $.process.run(['git', ...args], { cwd: directory, timeoutMs: PROCESS_TIMEOUT_MS })
  return ran.exitCode === 0 ? ran.stdout : ''
}

// A directory that is not a repository yet is asked again next time, since a later clone or init makes it one.
async function repoFacts($: EngineInterface, directory: string, host: Machine): Promise<RepoFacts | null> {
  const { value = {} } = await $.state.get(REPO_ROOTS)
  const cached = value[directory]
  if (cached) return cached
  if (!(await $.fs.exists(directory))) return null
  const [root, commonDir] = (await git($, directory, REPO_FACTS_ARGS)).split(/\r?\n/)
  if (!root || !commonDir) return null
  const facts = { root: resolveAbsolute(root, host), commonDir: resolveAbsolute(commonDir, host) }
  await $.state.set(REPO_ROOTS, { ...value, [directory]: facts })
  return facts
}

async function repoAt($: EngineInterface, shell: Shell, index: number, dashC: string | null): Promise<Repo> {
  const directory = invocationDirectory(shell.command, index, dashC, shell.cwd, shell.host)
  const facts = await repoFacts($, directory, shell.host)
  return facts ?? { root: directory, commonDir: null }
}

async function shellOf($: EngineInterface, command: string): Promise<Shell> {
  return { command, cwd: await $.session.cwd(), host: await machine($) }
}

// Keep the repository path only in the recovery command so long temp paths fit the hook output budget.
function destructiveRefusal(label: string, repo: string, dirty: string[]): string {
  const shown = dirty.slice(0, 10).map((line) => `  ${line}`)
  if (dirty.length > shown.length) shown.push(`  … +${dirty.length - shown.length} more`)
  return [
    `sidequest: refusing ${label} — the shared checkout (a board-registered project root; your evidence clone is not one) has ${dirty.length} uncommitted change(s) that this operation would destroy.`,
    ...shown,
    'Some of this may be a live executor\'s finished work that lost its worktree; the shared tree is not yours alone.',
    `Next step: preserve every dirty path in a named stash (for example, \`git stash push -u -m "sidequest recovery"\`), then run \`sidequest recover-shared --project "${repo}" --stash <stash@{n}> --yes\`. That exact recovery action verifies the stash before it runs \`git reset --hard && git clean -fd\`.`,
  ].join('\n')
}

function publicationRefusal(label: string, repo: string): string {
  return [
    `sidequest: refusing ${label} without the current session's publish lock.`,
    `  repo: ${repo}`,
    'Acquire it with `sidequest publish lock` before a deliberate release cut, then retry.',
    'This blocks the entire shell invocation, including earlier compound-command segments.',
    'This is a local early warning. Server-side GitHub rules remain the guarantee.',
  ].join('\n')
}

function sharedTreeCommitRefusal(ref: string): string {
  return [
    `sidequest: refusing raw git commit for ${ref} in the shared checkout.`,
    'Use mcp__plugin_sidequest_board__commit so Sidequest stages and commits only the approved ticket scope.',
    'If the path needs approval first, request scope before committing.',
  ].join('\n')
}

function isolatedMutationRefusal(root: string): string {
  return `sidequest: refusing a mutating git command against the shared checkout (${root}) from an isolated worktree. The shared checkout means the project's registered root and every other executor's worktree; a clone you created under your ticket's verification directory or scratchpad is not it and stays writable. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree.`
}

async function dirtyCheckoutDenial($: EngineInterface, shell: Shell): Promise<string | null> {
  const destructive = destructiveMatch(shell.command)
  if (!destructive) return null
  const { root } = await repoAt($, shell, destructive.index, destructive.dashC)
  if (!(await registeredRoot($, root, shell.host))) return null
  const dirty = (await git($, root, ['status', '--porcelain'])).split(/\r?\n/).filter(Boolean)
  return dirty.length ? destructiveRefusal(destructive.label, root, dirty) : null
}

async function upstreamOf($: EngineInterface, root: string): Promise<Upstream | null> {
  const ref = (await git($, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
  const slash = ref.indexOf('/')
  return slash > 0 ? { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) } : null
}

async function defaultBranch($: EngineInterface, root: string, remote: string): Promise<string> {
  const ref = (await git($, root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])).trim()
  if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1)
  const branches = (await git($, root, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`])).split(/\r?\n/)
    .map((branch) => branch.trim().replace(`${remote}/`, ''))
    .filter((branch) => branch && branch !== 'HEAD')
  return ['main', 'master', 'trunk'].find((branch) => branches.includes(branch)) || branches[0] || 'main'
}

async function pushRemote($: EngineInterface, root: string, tokens: string[], upstream: Upstream | null): Promise<{ remote: string; specs: string[] }> {
  const positional = tokens.filter((token) => !token.startsWith('-'))
  const [first, ...rest] = positional
  const named = first !== undefined && (await git($, root, ['remote', 'get-url', first])).trim() !== ''
  return named && first ? { remote: first, specs: rest } : { remote: upstream?.remote || 'origin', specs: positional }
}

function pushDestination(spec: string): string {
  return spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
}

function specPublishes(spec: string, defaultTarget: string, published: string, integration: string): boolean {
  const destination = pushDestination(spec)
  if (!destination || isTagRef(destination)) return true
  const target = destination === 'HEAD' ? defaultTarget : branchName(destination)
  return target === published && target !== integration
}

function pushPublishes(specs: string[], defaultTarget: string, published: string, integration: string): boolean {
  if (specs.length === 0) return defaultTarget === published && defaultTarget !== integration
  return specs.some((spec) => specPublishes(spec, defaultTarget, published, integration))
}

function wholesalePush(tokens: string[], specs: string[]): boolean {
  return pushesEverything(tokens) || specs.some((spec) => isTagRef(spec) || spec.includes('*'))
}

// The published branch a push lands on, or null when it lands elsewhere (the integration branch included).
async function publishedPushBranch($: EngineInterface, root: string, args: string, integration: string): Promise<string | null> {
  const tokens = shellTokens(args)
  const upstream = await upstreamOf($, root)
  const { remote, specs } = await pushRemote($, root, tokens, upstream)
  const published = await defaultBranch($, root, remote)
  if (wholesalePush(tokens, specs)) return published
  const defaultTarget = upstream?.branch || (await git($, root, ['branch', '--show-current'])).trim()
  return pushPublishes(specs, defaultTarget, published, integration) ? published : null
}

// Only a registered root has a board config; anything else keeps the 'main' default.
async function integrationBranch($: EngineInterface, root: string, host: Machine): Promise<string> {
  if (!(await registeredRoot($, root, host))) return 'main'
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/bin/sidequest.js`, 'board-config', '--json', '--project', root], { timeoutMs: PROCESS_TIMEOUT_MS })
    const config: { integrationBranch?: unknown } = JSON.parse(ran.stdout)
    return typeof config.integrationBranch === 'string' ? config.integrationBranch : 'main'
  } catch {
    // An unavailable board must not make ordinary Git commands fail closed.
    return 'main'
  }
}

async function lockHolder($: EngineInterface, commonDir: string): Promise<LockHolder | null> {
  try {
    const holder: LockHolder = JSON.parse(await $.fs.read(`${commonDir}/sidequest-publish.lock`))
    return holder
  } catch {
    return null
  }
}

async function publishLockHeld($: EngineInterface, shell: Shell, repo: Repo): Promise<boolean> {
  const holder = repo.commonDir ? await lockHolder($, repo.commonDir) : null
  if (!holder || holder.sessionId !== (await $.session.id())) return false
  return typeof holder.repo !== 'string' || samePath(holder.repo, repo.root, shell.host)
}

function publicationVerb(invocation: GitInvocation): boolean {
  return invocation.subcommand === 'push' || (invocation.subcommand === 'tag' && tagAction(invocation.args))
}

async function publicationLabel($: EngineInterface, shell: Shell, invocation: GitInvocation, root: string): Promise<string | null> {
  if (invocation.subcommand === 'tag') return 'manual git tag'
  const integration = await integrationBranch($, root, shell.host)
  const published = await publishedPushBranch($, root, invocation.args, integration)
  return published ? `a push to the published branch (${published})` : null
}

async function publicationDenial($: EngineInterface, shell: Shell): Promise<string | null> {
  for (const invocation of gitInvocations(shell.command).filter(publicationVerb)) {
    const repo = await repoAt($, shell, invocation.index, invocation.dashC)
    const label = await publicationLabel($, shell, invocation, repo.root)
    if (label) return (await publishLockHeld($, shell, repo)) ? null : publicationRefusal(label, repo.root)
  }
  return null
}

// Text first: no git process starts unless the command names a destructive or publishing invocation.
export async function destructiveGitDenial($: EngineInterface, rawCommand: string): Promise<string | null> {
  const command = withoutHereDocBodies(rawCommand)
  if (!destructiveMatch(command) && !gitInvocations(command).some(publicationVerb)) return null
  const shell = await shellOf($, command)
  return (await publicationDenial($, shell)) ?? (await dirtyCheckoutDenial($, shell))
}

async function agentWorktree($: EngineInterface, shell: Shell, root: string, project: string): Promise<boolean> {
  const cut = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  if (!root.slice(cut + 1).startsWith('agent-')) return false
  const parents = [`${await sidequestHome($, shell.host)}/worktrees/${await slugify(project, shell.host.windows)}`, `${project}/.claude/worktrees`]
  return parents.some((parent) => samePath(parent, root.slice(0, cut), shell.host))
}

// The board hands out the registered root and the agent worktrees; a clone an executor made itself under its
// verification directory or scratchpad belongs to nobody else and stays writable (SQ-3436).
async function protectedCheckout($: EngineInterface, shell: Shell, row: SnapshotRow, root: string, project: string): Promise<boolean> {
  if (samePath(root, project, shell.host)) return true
  if (!row.worktree || samePath(root, row.worktree, shell.host)) return false
  return agentWorktree($, shell, root, project)
}

async function isolatedMutationDenial($: EngineInterface, shell: Shell, row: SnapshotRow, root: string, project: string): Promise<string | null> {
  return (await protectedCheckout($, shell, row, root, project)) ? isolatedMutationRefusal(root) : null
}

function sharedTreeCommitDenial(row: SnapshotRow, subcommand: string, sharedCheckout: boolean): string | null {
  return row.state === 'claimed' && subcommand === 'commit' && sharedCheckout ? sharedTreeCommitRefusal(row.ref) : null
}

async function mutationDenial($: EngineInterface, shell: Shell, row: SnapshotRow, project: string, invocation: GitInvocation): Promise<string | null> {
  const { root } = await repoAt($, shell, invocation.index, invocation.dashC)
  if (!row.sharedTree) return isolatedMutationDenial($, shell, row, root, project)
  return sharedTreeCommitDenial(row, invocation.subcommand, samePath(root, project, shell.host))
}

// An isolated executor may not mutate a checkout the board handed to anyone else, and a shared-tree claim
// commits only through the board, which stages its approved scope alone.
export async function sharedCheckoutGitDenial($: EngineInterface, command: string, agentId: string | undefined): Promise<string | null> {
  const mutations = gitInvocations(command).filter((invocation) => MUTATING_SUBCOMMANDS.has(invocation.subcommand))
  if (!mutations.length) return null
  const row = await caller($, agentId)
  if (!row) return null
  const shell = await shellOf($, command)
  const project = await projectRoot($, shell.cwd, shell.host)
  for (const invocation of mutations) {
    const denial = await mutationDenial($, shell, row, project, invocation)
    if (denial) return denial
  }
  return null
}
