// Quartermaster's screens. The inbox: made-up hand runs, blocked commands and its proposals are written into a scratch
// copy of the story's project with the plugin's own store functions, read back, turned into candidates by its own
// detectors and drawn by its own pane code, once for each step from the proposal waiting to the standing yes saved.
// The one-time notice: the plugin's own notice lines for what a scratch project the older Toolshed "left" things in
// holds. The upgrade: its scan script reads that same project.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { detectCandidates } from '../../plugins/quartermaster/hooks/detectors.ts'
import type { SensedEvent } from '../../plugins/quartermaster/hooks/events.ts'
import type { SettingsFile } from '../../plugins/quartermaster/hooks/older-gateway.ts'
import { gatewayWiringIn } from '../../plugins/quartermaster/hooks/older-gateway.ts'
import { olderOnlyPluginsOn } from '../../plugins/quartermaster/hooks/older-leftovers.ts'
import { MARKETPLACE_AFTER_THE_SWITCH, quartermasterLines } from '../../plugins/quartermaster/hooks/older-toolshed.ts'
import type { LeftoverFound } from '../../plugins/quartermaster/hooks/older-toolshed.ts'
import { appendDayEvents, projectEventsDirectory, readEventsSince, readProposals, writeProposal } from '../../plugins/quartermaster/hooks/store.ts'
import type { Proposal } from '../../plugins/quartermaster/hooks/proposals.ts'
import { proposalCard } from '../../plugins/quartermaster/hooks/views/inbox.ts'
import type { Candidate } from '../../plugins/quartermaster/hooks/views/inbox.ts'
import { inboxPane } from '../../plugins/quartermaster/hooks/views/inbox-pane.tsx'
import type { InboxActions } from '../../plugins/quartermaster/hooks/views/inbox-pane.tsx'
import { readOptions, renderPlans, scan } from '../../plugins/quartermaster/scripts/upgrade-scan.mjs'
import type { QuartermasterInboxView } from '../../plugins/quartermaster/types/index.d.ts'

import { HOST_ELEMENTS, elementHtml } from './host-drawing.mts'
import * as madeUp from './made-up.mts'
import { noticeLines, paneFrame, terminalLines, terminalWindow } from './pages.mts'
import { diskFiles, writeText } from './scratch-project.mts'

const INBOX_COLUMNS = 72

const nothing = (): void => undefined

// Every press on a picture goes nowhere.
const NO_PRESSES: InboxActions = {
  showProposal: nothing,
  showCandidate: nothing,
  approve: nothing,
  reject: nothing,
  alreadyHandled: nothing,
  typeReason: nothing,
  later: nothing,
  draft: nothing,
  notNow: nothing,
  never: nothing,
  back: nothing,
}

const eventsOn = (day: string): SensedEvent[] => [
  ...madeUp.TYPED_BUILD_RUNS.filter(at => at.startsWith(day)).map((at): SensedEvent => ({ kind: 'typed', at, prefix: madeUp.TYPED_COMMAND })),
  ...madeUp.DENIED_RUNS.filter(at => at.startsWith(day)).map((at): SensedEvent => ({ kind: 'denial', at, tool: 'Bash', target: madeUp.DENIED_COMMAND })),
]

const daysOfTheEvents = (): string[] => [...new Set([...madeUp.TYPED_BUILD_RUNS, ...madeUp.DENIED_RUNS].map(at => at.slice(0, 10)))].sort()

async function seedTheEvents(projectFolder: string): Promise<void> {
  const written = new Map<string, string>()
  for (const day of daysOfTheEvents()) await appendDayEvents(diskFiles, projectEventsDirectory(projectFolder), madeUp.quartermasterSessionTagOn(day), day, eventsOn(day), written)
}

async function candidatesIn(projectFolder: string, now: number): Promise<Candidate[]> {
  const history = await readEventsSince(diskFiles, [projectEventsDirectory(projectFolder)], '2026-10-01')

  return detectCandidates(history, [], now)
}

const candidateOfKind = (candidates: readonly Candidate[], kind: string): Candidate => {
  const candidate = candidates.find(one => one.kind === kind)
  if (candidate === undefined) throw new Error(`Quartermaster noticed no ${kind} in the made-up project`)
  return candidate
}

type InboxStep = { proposals: readonly Proposal[]; view: QuartermasterInboxView }

const drawnInbox = async (projectFolder: string, now: number, step: InboxStep): Promise<string> => {
  for (const proposal of step.proposals) await writeProposal(diskFiles, projectFolder, proposal)
  const { proposals } = await readProposals(diskFiles, projectFolder)
  const records = { proposals: proposals.map(proposalCard), rejected: [], setAsideForNow: [] }
  const content = { records, candidates: await candidatesIn(projectFolder, now), view: step.view }

  return terminalWindow('claude', paneFrame('Quartermaster', INBOX_COLUMNS, elementHtml(inboxPane(HOST_ELEMENTS, content, NO_PRESSES))))
}

export type InboxDrawings = {
  waiting: string
  proposal: string
  applied: string
  noticed: string
  standingYes: string
  standingYesSaved: string
}

/** The inbox at each step, after the PAY-41 run: in the order the person goes through it. */
export async function quartermasterInbox(projectFolder: string, now: number): Promise<InboxDrawings> {
  await seedTheEvents(projectFolder)
  const candidates = await candidatesIn(projectFolder, now)
  const script: Proposal = { ...madeUp.PROPOSAL, evidence: [candidateOfKind(candidates, 'script').fingerprint] }
  const denials = candidateOfKind(candidates, 'permission')
  const standingYes: Proposal = { ...madeUp.STANDING_YES, evidence: [denials.fingerprint] }
  const drawn = (step: InboxStep) => drawnInbox(projectFolder, now, step)

  return {
    waiting: await drawn({ proposals: [script], view: {} }),
    proposal: await drawn({ proposals: [], view: { proposal: script.id } }),
    applied: await drawn({ proposals: [{ ...script, status: 'applied' }], view: {} }),
    noticed: await drawn({ proposals: [], view: { candidate: denials.fingerprint } }),
    standingYes: await drawn({ proposals: [standingYes], view: { proposal: standingYes.id } }),
    standingYesSaved: await drawn({ proposals: [{ ...standingYes, status: 'applied' }], view: {} }),
  }
}

const git = (projectFolder: string, ...gitArguments: string[]): void => {
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: madeUp.MADE_UP_AUTHOR,
    GIT_AUTHOR_EMAIL: `${madeUp.MADE_UP_AUTHOR}@example.com`,
    GIT_COMMITTER_NAME: madeUp.MADE_UP_AUTHOR,
    GIT_COMMITTER_EMAIL: `${madeUp.MADE_UP_AUTHOR}@example.com`,
    GIT_AUTHOR_DATE: madeUp.MADE_UP_COMMIT_DATE,
    GIT_COMMITTER_DATE: madeUp.MADE_UP_COMMIT_DATE,
    GIT_CONFIG_GLOBAL: `${projectFolder}/../no-global-gitconfig`,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const ran = spawnSync('git', gitArguments, { cwd: projectFolder, env: environment, encoding: 'utf8' })
  if (ran.status !== 0) throw new Error(`git ${gitArguments.join(' ')} failed: ${ran.stderr}`)
}

// A project that ran the older Toolshed: its rules and map folders, and an older-only plugin still switched on.
export function seedOlderProject(projectFolder: string): void {
  for (const file of [madeUp.PROJECT_FILE, madeUp.OLDER_RULE_FILE, madeUp.OLDER_MAP_FILE]) writeText(`${projectFolder}/${file.path}`, file.text)
  const enabledPlugins = Object.fromEntries(madeUp.OLDER_PLUGINS_ON.map(name => [`${name}@${MARKETPLACE_AFTER_THE_SWITCH}`, true]))
  writeText(`${projectFolder}/.claude/settings.json`, `${JSON.stringify({ enabledPlugins }, null, 2)}\n`)
  git(projectFolder, 'init', '-q', '-b', 'main')
  // Only the project's own file is committed: the older plugins' folders sat beside it untracked, as in a solo project.
  git(projectFolder, 'add', madeUp.PROJECT_FILE.path)
  git(projectFolder, 'commit', '-q', '-m', 'Notes for trips')
}

// What the made-up project holds of the older Toolshed: the two folders it was seeded with. The plugin's own
// session-start look takes the whole host engine, which a picture has no stand-in for, so the folders are named here.
const OLDER_FOLDERS: readonly (LeftoverFound & { folder: string })[] = [
  { kind: 'map', where: '.claude/.codebase-info/', folder: '.claude/.codebase-info' },
  { kind: 'rules', where: '.claude/live-rules', folder: '.claude/live-rules' },
]

const leftoversIn = (projectFolder: string): LeftoverFound[] =>
  OLDER_FOLDERS.filter(older => existsSync(`${projectFolder}/${older.folder}`)).map(older => ({ kind: older.kind, where: older.where }))

const PROJECT_SETTINGS = ['.claude/settings.local.json', '.claude/settings.json']

const settingsIn = (projectFolder: string): SettingsFile[] =>
  PROJECT_SETTINGS.filter(label => existsSync(`${projectFolder}/${label}`)).map(label => ({ label, text: readFileSync(`${projectFolder}/${label}`, 'utf8'), isUserWide: false }))

const UPGRADE_NOTICE_COLUMNS = 76

export function olderToolshedNotice(projectFolder: string): string {
  const settings = settingsIn(projectFolder)
  const lines = quartermasterLines(leftoversIn(projectFolder), olderOnlyPluginsOn(settings), gatewayWiringIn(settings))
  if (lines.length === 0) throw new Error('Quartermaster said nothing about the made-up older project')

  return terminalWindow('claude', noticeLines(lines.join('\n'), UPGRADE_NOTICE_COLUMNS))
}

const SHOWN_PROJECT = `~/projects/${madeUp.UPGRADE_PROJECT}`
const SCAN_TYPED = `node <plugin folder>/scripts/upgrade-scan.mjs --project ${SHOWN_PROJECT} --home ~`

const replacedEverywhere = (text: string, folder: string, shownAs: string): string =>
  text.split(folder).join(shownAs).split(folder.replace(/\//g, '\\')).join(shownAs)

// The scan prints the scratch folders where a real run prints the person's; they are shown as a person would see theirs.
const withScratchPathsHidden = (printed: string, projectFolder: string, homeFolder: string): string => {
  const home = replacedEverywhere(printed, homeFolder, '~').replace(/~\\/g, '~/')
  const parent = projectFolder.slice(0, projectFolder.lastIndexOf('/'))

  return replacedEverywhere(home, parent, '~/projects').replace(/~\/projects\\/g, '~/projects/')
}

export function upgradeScan(projectFolder: string, homeFolder: string): string {
  const options = readOptions(['--project', projectFolder, '--home', homeFolder], {}, projectFolder)
  const printed = renderPlans([scan(options)], false, madeUp.FIRST_MINUTE)

  return terminalWindow('Terminal', terminalLines(SCAN_TYPED, withScratchPathsHidden(printed, projectFolder, homeFolder)))
}
