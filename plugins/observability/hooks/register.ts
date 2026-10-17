import { atom, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { boardHtml } from '../lib/board.mjs'
import {
  addAgent,
  addStep,
  addSubagentUsage,
  addToolCall,
  appendLine,
  foldTurn,
  freshRecording,
  nextRecording,
  notePrompt,
  projectSlug,
  rowsSince,
  tokensOf,
} from './ledger.ts'
import type { TurnRow } from './ledger.ts'

const BOARD_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
// $.fs.read refuses files over 4 MiB, so a ledger is rolled aside well before that.
const LEDGER_CAP = 3 * 1024 * 1024

const recording = atom({ plugin: 'observability', key: 'turn' } as const, freshRecording())

type Project = { root: string; slug: string }

async function readProject($: EngineInterface): Promise<Project> {
  const repo = await $.session.repo().catch(() => null)
  const root = repo?.root ?? (await $.session.cwd())
  return { root, slug: projectSlug(root) }
}

const trackKey = (project: Project) => `track:${project.root}`
const isTracked = async ($: EngineInterface, project: Project) => (await $.store.get(trackKey(project))) === true

async function observabilityDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured !== undefined) return `${configured}/observability`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return `${home}/.claude/observability`
}

const ledgerFile = async ($: EngineInterface, project: Project) => `${await observabilityDir($)}/ledger/${project.slug}.jsonl`

async function appendRow($: EngineInterface, file: string, row: TurnRow) {
  const existing = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
  if (existing.length < LEDGER_CAP) return $.fs.write(file, appendLine(existing, row))
  await $.fs.write(file.replace(/\.jsonl$/, `.${Date.parse(row.at)}.jsonl`), existing)
  await $.fs.write(file, appendLine('', row))
}

// The board shows the last 90 days of every project's ledgers, rolled-aside ones included.
async function writeBoard($: EngineInterface): Promise<string> {
  const dir = await observabilityDir($)
  const entries = await $.fs.list(`${dir}/ledger`).catch(() => [])
  const ledgers = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
  const texts = await Promise.all(ledgers.map(entry => $.fs.read(`${dir}/ledger/${entry.name}`).catch(() => '')))
  const now = await $.clock.now()
  const rows = texts.flatMap(text => rowsSince(text, now - BOARD_DAYS * DAY_MS))
  const file = `${dir}/board.html`
  await $.fs.write(file, boardHtml(rows, now))
  return file
}

async function openFile($: EngineInterface, file: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  if (isWindows) return $.process.run(['cmd', '/c', 'start', '', file.replace(/\//g, '\\')])
  const isMac = (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  return $.process.run([isMac ? 'open' : 'xdg-open', file])
}

// What each `/observability:track` argument sets; undefined only reports.
const TRACK_CHOICES: Record<string, boolean | undefined> = { on: true, off: false, status: undefined, '': undefined }

async function trackCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const choice = args.trim()
  if (!Object.hasOwn(TRACK_CHOICES, choice)) return { text: 'Usage: /observability:track on|off|status' }
  const project = await readProject($)
  const tracked = TRACK_CHOICES[choice]
  if (tracked !== undefined) await $.store.set(trackKey(project), tracked)
  return { text: await trackingStatus($, project) }
}

async function trackingStatus($: EngineInterface, project: Project): Promise<string> {
  if (!(await isTracked($, project))) return `observability: not recording turns for ${project.root}`
  return `observability: recording turns for ${project.root}, into ${await ledgerFile($, project)}`
}

async function boardCommand($: EngineInterface): Promise<{ text: string }> {
  const file = await writeBoard($)
  await openFile($, file)
  return { text: `observability: board written to ${file}` }
}

let pendingBoard: Timer | undefined

function scheduleBoard($: EngineInterface) {
  if (pendingBoard !== undefined) return
  pendingBoard = $.clock.after(2000, () => {
    pendingBoard = undefined
    void writeBoard($).catch(() => $.ui.status('observability: could not rebuild the board'))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'track', description: 'Record this project’s turns into the observability ledger', argumentHint: 'on|off|status' })
    await $.command.register({ name: 'board', description: 'Build the observability board from every tracked project and open it' })
    const usage = await $.session.usage()
    await update($, recording, current => ({ ...current, costUsd: usage.cost?.usd ?? current.costUsd }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'track' }, ($, e) => trackCommand($, e.args)).catch(() => ({ text: 'observability: track failed' }))

  on('command.run', { command: 'board' }, $ => boardCommand($)).catch(() => ({ text: 'observability: could not build or open the board' }))

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (e.origin.kind !== 'plugin' && e.command === undefined && text !== '') await update($, recording, current => notePrompt(current, text))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    const latencyMs = (await $.clock.now()) - startedAt
    await update($, recording, current => addStep(current, { model: e.model, latencyMs, usage: tokensOf(result.usage) }))
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const call = { tool: e.tool, ms, isError: result.isError === true, isDenied: result.deny !== undefined }
    await update($, recording, current => addToolCall(current, call))
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    await update($, recording, current => addAgent(current, e.subagentType))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    await update($, recording, current => ({ ...current, compacted: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await update($, recording, current => addSubagentUsage(current, tokensOf(e.usage)))
      return next(e)
    }
    const project = await readProject($)
    const sessionUsage = await $.session.usage()
    const end = {
      at: new Date(await $.clock.now()).toISOString(),
      project: project.slug,
      session: await $.session.id(),
      startedAt: sessionUsage.startedAt,
      turn: await $.session.turns(),
      reason: e.reason,
      durationMs: e.durationMs,
      usage: tokensOf(e.usage),
      sessionUsage,
      model: await $.session.model(),
      version: (await $.session.version()).version,
    }
    let row: TurnRow | undefined
    await update($, recording, current => {
      row = foldTurn(current, end)
      return nextRecording(current, row.costUsd)
    })
    if (row !== undefined && (await isTracked($, project))) {
      await appendRow($, await ledgerFile($, project), row).catch(() => $.ui.status('observability: could not write the ledger'))
      scheduleBoard($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear starts a new task: its name and ticket come from the next prompt.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, recording, current => freshRecording(current.costUsd))
    return next(e)
  }).catch(($, e, next) => next(e))
}
