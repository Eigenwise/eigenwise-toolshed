import type { CommandRunResult, EngineInterface, Hook, On } from 'claude-code'

import { runProposalOperation } from '../proposal-tool'
import type { Workspace } from '../proposal-tool'
import { addRejections, readImpressions, readProposals, readRejections, recordImpression } from '../store'
import type { FileSystem } from '../store'
import { isSetAsideForNow } from '../impressions'
import type { ImpressionKind } from '../impressions'
import { homeOf } from '../home'
import { impressionsPathFor } from '../session-memory'
import {
  EMPTY_RECORDS,
  applySkillRun,
  draftSkillRun,
  inboxText,
  noticedCandidates,
  proposalCard,
  proposalFingerprint,
  refusalInWords,
  statusLine,
  typedLine,
} from './inbox'
import type { Candidate, Records, SkillRun } from './inbox'
import { candidateToOffer, isRealPause, offerToast } from './offer'
import type { TurnEnd } from './offer'
import { inboxPane } from './inbox-pane'
import type { InboxActions } from './inbox-pane'

const PANE = 'quartermaster'
const OFFER_TOAST_MS = 10_000

const recordsRef = { plugin: 'quartermaster', key: 'records' } as const
const viewRef = { plugin: 'quartermaster', key: 'view' } as const
const reasonRef = { plugin: 'quartermaster', key: 'rejectionReason' } as const
const offerRef = { plugin: 'quartermaster', key: 'offer' } as const
const candidatesRef = { plugin: 'quartermaster', key: 'candidates' } as const

function filesOf($: EngineInterface): FileSystem {
  return {
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    list: path => $.fs.list(path),
  }
}

async function workspaceOf($: EngineInterface): Promise<Workspace> {
  const cwd = await $.session.cwd()

  return { files: filesOf($), cwd, impressionsPath: impressionsPathFor(await homeOf($), cwd), now: await $.clock.now() }
}

/** Set at each turn's end and cleared by the first turn whose events were written, so the status clears itself. */
let writeProblem: string | undefined

async function refreshRecords($: EngineInterface): Promise<Records> {
  const { files, cwd, impressionsPath, now } = await workspaceOf($)
  const { proposals } = await readProposals(files, cwd)
  const rejected = (await readRejections(files, cwd)).map(rejection => rejection.fingerprint)
  const impressions = await readImpressions(files, cwd, impressionsPath).catch(() => [])
  const cards = proposals.map(proposalCard)
  const fingerprints = [...(await currentCandidates($)).map(candidate => candidate.fingerprint), ...cards.map(proposalFingerprint)]
  const setAsideForNow = fingerprints.filter(fingerprint => isSetAsideForNow(fingerprint, impressions, now))
  const records: Records = { proposals: cards, rejected, setAsideForNow }
  await $.state.set(recordsRef, records)
  $.ui.status(statusLine(records, writeProblem))

  return records
}

async function currentCandidates($: EngineInterface): Promise<Candidate[]> {
  return (await $.state.get(candidatesRef)).value ?? []
}

async function logImpression($: EngineInterface, fingerprint: string, kind: ImpressionKind): Promise<void> {
  const { files, cwd, impressionsPath, now } = await workspaceOf($)
  await recordImpression(files, cwd, impressionsPath, { at: new Date(now).toISOString(), fingerprint, kind })
}

/**
 * Runs the skill as if the person typed it, so the change happens in the open.
 * Where no command can run, the line waits in the prompt box for them to send.
 */
async function runSkill($: EngineInterface, run: SkillRun): Promise<void> {
  const hasRun = await $.command.run(run).then(
    () => true,
    () => false,
  )
  if (!hasRun) await $.prompt.fill({ text: typedLine(run) })
}

async function showList($: EngineInterface): Promise<void> {
  await $.state.set(viewRef, {})
  await refreshRecords($)
}

async function decide($: EngineInterface, id: string, decision: string, reason?: string): Promise<boolean> {
  const answer = await runProposalOperation({ operation: 'decide', id, decision, reason }, await workspaceOf($))
  if ('deny' in answer) $.ui.toast(refusalInWords(answer.deny))

  return !('deny' in answer)
}

async function approve($: EngineInterface, id: string): Promise<void> {
  const isAccepted = await decide($, id, 'approve')
  await showList($)
  if (isAccepted) await runSkill($, applySkillRun(id))
}

async function draft($: EngineInterface, fingerprint: string): Promise<void> {
  await showList($)
  await runSkill($, draftSkillRun(fingerprint))
}

async function neverHere($: EngineInterface, fingerprint: string): Promise<void> {
  const { files, cwd, now } = await workspaceOf($)
  const date = new Date(now).toISOString().slice(0, 10)
  await addRejections(files, cwd, [{ fingerprint, reason: 'ignored in this project, from the /qm pane', date }])
  await logImpression($, fingerprint, 'never')
  await showList($)
}

const NO_REASON = 'no reason given'

async function reject($: EngineInterface, id: string): Promise<void> {
  const typedReason = ((await $.state.get(reasonRef)).value ?? '').trim()
  await $.state.set(reasonRef, '')
  const isRejected = await decide($, id, 'reject', typedReason === '' ? NO_REASON : typedReason)
  if (isRejected) $.ui.toast('Rejected. Quartermaster will not suggest this again in this project.')
  await showList($)
}

async function notNow($: EngineInterface, fingerprint: string): Promise<void> {
  await logImpression($, fingerprint, 'not-now')
  await showList($)
}

function actionsFor($: EngineInterface): InboxActions {
  return {
    showProposal: id => void $.state.set(reasonRef, '').then(() => $.state.set(viewRef, { proposal: id })),
    showCandidate: fingerprint => void $.state.set(viewRef, { candidate: fingerprint }),
    approve: id => void approve($, id),
    reject: id => void reject($, id),
    typeReason: reason => void $.state.set(reasonRef, reason),
    later: id => void decide($, id, 'later').then(() => showList($)),
    draft: fingerprint => void draft($, fingerprint),
    notNow: fingerprint => void notNow($, fingerprint),
    never: fingerprint => void neverHere($, fingerprint),
    back: () => void $.state.set(viewRef, {}),
  }
}

async function markOfferReviewed($: EngineInterface): Promise<void> {
  const { value: offer } = await $.state.get(offerRef)
  if (offer === undefined || offer.isReviewed) return
  await logImpression($, offer.fingerprint, 'review')
  await $.state.set(offerRef, { ...offer, isReviewed: true })
}

async function agentStatuses($: EngineInterface): Promise<string[]> {
  return (await $.agent.list().catch(() => [])).map(agent => agent.status)
}

async function offerOnce($: EngineInterface, turn: TurnEnd, records: Records): Promise<void> {
  if ((await $.state.get(offerRef)).value !== undefined) return
  if (!isRealPause(turn, await agentStatuses($))) return
  const { files, cwd, impressionsPath, now } = await workspaceOf($)
  const noticed = noticedCandidates(await currentCandidates($), records)
  const candidate = candidateToOffer(noticed, await readImpressions(files, cwd, impressionsPath), now)
  if (candidate === undefined) return
  $.ui.toast(offerToast(candidate), { timeoutMs: OFFER_TOAST_MS })
  await $.state.set(offerRef, { fingerprint: candidate.fingerprint, isReviewed: false })
  await logImpression($, candidate.fingerprint, 'shown').catch(() => undefined)
}

/** Called by the core once it has published, so the inbox reads this session's candidates. */
export async function startInbox($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'qm',
    description: "Quartermaster's suggested fixes for you to answer, and what it noticed in this project",
    immediate: true,
  })
  await refreshRecords($)
}

/** Called by the core after a main-loop turn, once this turn's candidates are published. */
export async function offerAtPause($: EngineInterface, turn: TurnEnd, eventsProblem?: string): Promise<void> {
  writeProblem = eventsProblem
  await offerOnce($, turn, await refreshRecords($))
}

/** An offer the person never opened is evidence the next offer should wait. */
export async function logIgnoredOffer($: EngineInterface): Promise<void> {
  const { value: offer } = await $.state.get(offerRef)
  if (offer !== undefined && !offer.isReviewed) {
    await logImpression($, offer.fingerprint, 'ignored')
    await $.state.set(offerRef, { ...offer, isReviewed: true })
  }
}

async function openInbox($: EngineInterface): Promise<CommandRunResult> {
  await markOfferReviewed($)
  await $.state.set(viewRef, {})
  const records = await refreshRecords($)
  const opened = await $.ui.open({ id: PANE, title: 'Quartermaster' }).catch(() => undefined)

  return opened?.isPlaced === true ? {} : { text: inboxText(records, await currentCandidates($)) }
}

/** The /qm command and the inbox pane. */
export const registerViews = (on: On): void => {
  on('command.run', { command: 'qm' }, openInbox).catch(() => ({
    text: 'Quartermaster could not open. Its suggestions are files in .claude/quartermaster/proposals/.',
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const content = {
      records: (await $.state.get(recordsRef)).value ?? EMPTY_RECORDS,
      candidates: await currentCandidates($),
      view: (await $.state.get(viewRef)).value ?? {},
    }

    return inboxPane($.ui.resolve(e), content, actionsFor($))
  })
}
