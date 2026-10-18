import type { EngineInterface } from 'claude-code'

import { callerRow } from './context-guards.js'
import type { Snapshot, SnapshotRow } from './context-guards.js'
import { resolveAbsolute } from './text-guards.js'
import type { Machine } from './text-guards.js'

// The module mirrors src/lib/store/paths.ts (homeRoot, nearestRepoRoot, slugify) to find the snapshot the
// store writes, since it cannot load the store. A slug it gets wrong reads no rows and every guard stays silent.

export async function machine($: EngineInterface): Promise<Machine> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (windows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? ''
  return { home, windows }
}

async function readOrNull($: EngineInterface, file: string): Promise<string | null> {
  try {
    return await $.fs.read(file)
  } catch {
    return null
  }
}

// A linked worktree always holds a .git file, and $.fs can only read files.
export async function worktreeExists($: EngineInterface, worktree: string): Promise<boolean> {
  return (await readOrNull($, `${worktree}/.git`)) !== null
}

function parentOf(directory: string): string {
  const cut = Math.max(directory.lastIndexOf('/'), directory.lastIndexOf('\\'))
  return cut > directory.search(/[\\/]/) ? directory.slice(0, cut) : directory.slice(0, cut + 1)
}

const LINKED_WORKTREE = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/

// A linked worktree's .git file names its main checkout, which is the board's project root.
async function gitRootAt($: EngineInterface, directory: string): Promise<string | null> {
  const gitFile = await readOrNull($, `${directory}/.git`)
  if (gitFile !== null) return LINKED_WORKTREE.exec(gitFile.trim())?.[1] ?? directory
  return (await readOrNull($, `${directory}/.git/HEAD`)) !== null ? directory : null
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string> {
  const marker = cwd.search(/[\\/]\.claude[\\/]worktrees[\\/]/)
  if (marker >= 0) return cwd.slice(0, marker)
  for (let directory = cwd; ; directory = parentOf(directory)) {
    const root = await gitRootAt($, directory)
    if (root !== null) return root
    if (parentOf(directory) === directory) return cwd
  }
}

export async function slugify(root: string, windows: boolean): Promise<string> {
  const base = (root.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(windows ? root.toLowerCase() : root))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 8)
  return `${base}-${hash}`
}

export async function sidequestHome($: EngineInterface, host: Machine): Promise<string> {
  const configured = (await $.env.get('SIDEQUEST_HOME'))?.trim()
  if (configured) return resolveAbsolute(configured, host)
  return resolveAbsolute(`${host.home}/.claude/sidequest`, host)
}

const projectDirectories = new Map<string, Promise<string>>()

// The registered root a cwd belongs to: a linked worktree's main checkout, else the enclosing repo.
export async function projectRoot($: EngineInterface, cwd: string, host: Machine): Promise<string> {
  return resolveAbsolute(await repoRoot($, cwd), host)
}

async function locateProjectDirectory($: EngineInterface, cwd: string): Promise<string> {
  const host = await machine($)
  return `${await sidequestHome($, host)}/projects/${await slugify(await projectRoot($, cwd, host), host.windows)}`
}

// The store creates projects/<slug>/tickets when it registers a root, and the slug hashes that exact path,
// so only the registered root itself has one, never a clone or a linked worktree of it.
export async function registeredRoot($: EngineInterface, root: string, host: Machine): Promise<boolean> {
  return $.fs.exists(`${await sidequestHome($, host)}/projects/${await slugify(root, host.windows)}/tickets`)
}

// The board folder of the session's project; cached per cwd because a session rarely moves.
export function projectDirectory($: EngineInterface, cwd: string): Promise<string> {
  let directory = projectDirectories.get(cwd)
  if (!directory) {
    directory = locateProjectDirectory($, cwd)
    projectDirectories.set(cwd, directory)
  }
  return directory
}

export async function boardExists($: EngineInterface, directory: string): Promise<boolean> {
  return (await readOrNull($, `${directory}/meta.json`)) !== null
}

export async function readSnapshot($: EngineInterface, directory: string): Promise<Snapshot | null> {
  const text = await readOrNull($, `${directory}/dispatch-snapshot.json`)
  if (text === null) return null
  const parsed = JSON.parse(text) as { v?: number } & Snapshot
  return parsed.v === 1 && Array.isArray(parsed.dispatches) ? parsed : null
}

export async function sessionRows($: EngineInterface): Promise<SnapshotRow[]> {
  return (await readSnapshot($, await projectDirectory($, await $.session.cwd())))?.dispatches ?? []
}

export async function caller($: EngineInterface, agentId: string | undefined): Promise<SnapshotRow | null> {
  return callerRow(await sessionRows($), agentId, await $.session.id())
}
