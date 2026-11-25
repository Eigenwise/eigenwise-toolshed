import type { CommandRunResult, EngineInterface, Hook, On } from 'claude-code'

import { runProposalOperation } from '../proposal-tool'
import type { Workspace } from '../proposal-tool'
import { addRejections, forgetStoredProposals, readImpressions, readProposals, readRejections, recordImpression } from '../store'
import type { FileSystem } from '../store'
import { isSetAsideForNow, waitEndsOn } from '../impressions'
import type { Impression } from '../impressions'
import type { ImpressionKind } from '../impressions'
import { homeOf } from '../home'
import { impressionsPathFor } from '../session-memory'
import {
  EMPTY_RECORDS,
  answerLine,
  applySkillRun,
  draftSkillRun,
  handledWithinWindow,
  inboxText,
  projectNameOf,
  noticedCandidates,
  proposalCard,
  proposalFingerprint,
  refusalInWords,
  statusLine,
  typedLine,
} from './inbox'
import type { Candidate, ProposalCard, Records, SkillRun } from './inbox'
import {
  candidateToOffer,
  isRealPause,
  isStandingOffer,
  offerToast,
  skillAnswersOffer,
  standingFingerprint,
  standingToOffer,
  standingToast,
} from './offer'
import type { TurnEnd } from './offer'
import { inboxPane } from './inbox-pane'
import type { InboxActions } from './inbox-pane'

const PANE = 'quartermaster'
const OFFER_TOAST_MS = 10_000

const recordsRef = { plugin: 'quartermaster', key: 'records' } as const
const viewRef = { plugin: 'quartermaster', key: 'view' } as const
const pressProblemRef = { plugin: 'quartermaster', key: 'pressProblem' } as const
const reasonRef = { plugin: 'quartermaster', key: 'rejectionReason' } as const
const offerRef = { plugin: 'quartermaster', key: 'offer' } as const
const candidatesRef = { plugin: 'quartermaster', key: 'candidates' } as const
const dueRef = { plugin: 'quartermaster', key: 'due' } as const

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

function waitEndDays(fingerprints: readonly string[], impressions: readonly Impression[]): Record<string, string> {
  const days = fingerprints.map(fingerprint => [fingerprint, waitEndsOn(fingerprint, impressions)] as const)

  return Object.fromEntries(days.filter((entry): entry is readonly [string, string] => entry[1] !== undefined))
}

async function refreshRecords($: EngineInterface): Promise<Records> {
  const { files, cwd, impressionsPath, now } = await workspaceOf($)
  const { proposals } = await readProposals(files, cwd)
  const rejected = (await readRejections(files, cwd)).map(rejection => rejection.fingerprint)
  const impressions = await readImpressions(files, cwd, impressionsPath).catch(() => [])
  const cards = proposals.map(proposalCard)
  const fingerprints = [...(await currentCandidates($)).map(candidate => candidate.fingerprint), ...cards.map(proposalFingerprint)]
  const setAsideForNow = fingerprints.filter(fingerprint => isSetAsideForNow(fingerprint, impressions, now))
  const records: Records = {
    proposals: cards,
    rejected,
    handledWithinWindow: handledWithinWindow(cards, now),
    setAsideForNow,
    setAsideUntil: waitEndDays(setAsideForNow, impressions),
  }
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

async function showListUnlessPressFailed($: EngineInterface): Promise<void> {
  if (((await $.state.get(pressProblemRef)).value ?? '') === '') await showList($)
  else await refreshRecords($)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function showPressProblem($: EngineInterface, problem: string): Promise<void> {
  await $.state.set(pressProblemRef, problem)
  $.ui.toast(problem)
}

/** True once the proposal file holds the answer, also when a rejection's never-again line could not be written. */
async function decide($: EngineInterface, id: string, decision: string, reason?: string): Promise<boolean> {
  await $.state.set(pressProblemRef, '')
  try {
    const answer = await runProposalOperation({ operation: 'decide', id, decision, reason }, await workspaceOf($))
    if ('deny' in answer) $.ui.toast(refusalInWords(answer.deny))
    else if (answer.neverAgainError !== undefined) {
      await showPressProblem($, `${id} is rejected, but the never-again line was not written to rejected.md: ${answer.neverAgainError}`)
    }

    return !('deny' in answer)
  } catch (error) {
    await showPressProblem($, `Your answer for ${id} was not saved: ${errorText(error)}`)

    return false
  }
}

async function approve($: EngineInterface, id: string): Promise<void> {
  const isAccepted = await decide($, id, 'approve')
  await showListUnlessPressFailed($)
  if (isAccepted) await runSkill($, applySkillRun(id))
}

async function draft($: EngineInterface, fingerprint: string): Promise<void> {
  await showList($)
  await runSkill($, draftSkillRun(fingerprint))
}

async function neverHere($: EngineInterface, fingerprint: string): Promise<void> {
  const { files, cwd, now } = await workspaceOf($)
  const date = new Date(now).toISOString().slice(0, 10)
  await addRejections(files, cwd, [{ fingerprint, reason: 'ignored in this project, from the /quartermaster pane', date }])
  await logImpression($, fingerprint, 'never')
  await showList($)
}

const NO_REASON = 'no reason given'

type WordedAnswer = { decision: 'reject' | 'handled'; wording: 'rejected' | 'already handled'; toast: string }

const REJECT_ANSWER: WordedAnswer = {
  decision: 'reject',
  wording: 'rejected',
  toast: 'Rejected. Quartermaster will not suggest this again in this project.',
}

const HANDLED_ANSWER: WordedAnswer = {
  decision: 'handled',
  wording: 'already handled',
  toast: 'Closed as already handled. It may come back if the same thing keeps happening.',
}

/**
 * Only a reason the person typed is sent: it is a message, so the agent answers it. A press with nothing typed starts no turn.
 * A session that cannot take the line must not undo the answer.
 */
async function tellSession($: EngineInterface, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text })
  } catch {
    // The answer is saved either way.
  }
}

async function hasPressProblem($: EngineInterface): Promise<boolean> {
  return ((await $.state.get(pressProblemRef)).value ?? '') !== ''
}

async function typedReasonOf($: EngineInterface): Promise<string> {
  return ((await $.state.get(reasonRef)).value ?? '').trim()
}

async function cardOf($: EngineInterface, id: string): Promise<ProposalCard | undefined> {
  return ((await $.state.get(recordsRef)).value ?? EMPTY_RECORDS).proposals.find(proposal => proposal.id === id)
}

const reasonToKeep = (answer: WordedAnswer, typedReason: string): string =>
  answer.decision === 'reject' && typedReason === '' ? NO_REASON : typedReason

async function afterAnswer($: EngineInterface, card: ProposalCard | undefined, answer: WordedAnswer, typedReason: string): Promise<void> {
  if (card !== undefined && typedReason !== '') void tellSession($, answerLine(answer.wording, card, typedReason))
  if (await hasPressProblem($)) return
  await $.state.set(reasonRef, '')
  $.ui.toast(answer.toast)
}

async function answerWithReason($: EngineInterface, id: string, answer: WordedAnswer): Promise<void> {
  const typedReason = await typedReasonOf($)
  const card = await cardOf($, id)
  const isAnswered = await decide($, id, answer.decision, reasonToKeep(answer, typedReason))
  if (isAnswered) await afterAnswer($, card, answer, typedReason)
  await showListUnlessPressFailed($)
}

async function notNow($: EngineInterface, fingerprint: string): Promise<void> {
  await logImpression($, fingerprint, 'not-now')
  await showList($)
}

function actionsFor($: EngineInterface): InboxActions {
  return {
    showProposal: id =>
      void $.state
        .set(reasonRef, '')
        .then(() => $.state.set(pressProblemRef, ''))
        .then(() => $.state.set(viewRef, { proposal: id })),
    showCandidate: fingerprint => void $.state.set(viewRef, { candidate: fingerprint }),
    approve: id => void approve($, id),
    reject: id => void answerWithReason($, id, REJECT_ANSWER),
    alreadyHandled: id => void answerWithReason($, id, HANDLED_ANSWER),
    typeReason: reason => void $.state.set(reasonRef, reason),
    later: id => void decide($, id, 'later').then(() => showListUnlessPressFailed($)),
    draft: fingerprint => void draft($, fingerprint),
    notNow: fingerprint => void notNow($, fingerprint),
    never: fingerprint => void neverHere($, fingerprint),
    back: () => void $.state.set(pressProblemRef, '').then(() => $.state.set(viewRef, {})),
  }
}

async function markOfferReviewed($: EngineInterface): Promise<void> {
  const { value: offer } = await $.state.get(offerRef)
  if (offer === undefined || offer.isReviewed || isStandingOffer(offer.fingerprint)) return
  await logImpression($, offer.fingerprint, 'review')
  await $.state.set(offerRef, { ...offer, isReviewed: true })
}

async function agentStatuses($: EngineInterface): Promise<string[]> {
  return (await $.agent.list().catch(() => [])).map(agent => agent.status)
}

async function showOffer($: EngineInterface, fingerprint: string, text: string): Promise<void> {
  $.ui.toast(text, { timeoutMs: OFFER_TOAST_MS })
  await $.state.set(offerRef, { fingerprint, isReviewed: false })
  await logImpression($, fingerprint, 'shown').catch(() => undefined)
}

type OfferText = { fingerprint: string; text: string }

async function offerToShow($: EngineInterface, records: Records): Promise<OfferText | undefined> {
  const { files, cwd, impressionsPath, now } = await workspaceOf($)
  const impressions = await readImpressions(files, cwd, impressionsPath)
  const standing = standingToOffer((await $.state.get(dueRef)).value ?? [], impressions, now)
  if (standing !== undefined) return { fingerprint: standingFingerprint(standing), text: standingToast(standing) }
  const candidate = candidateToOffer(noticedCandidates(await currentCandidates($), records), impressions, now)

  return candidate === undefined ? undefined : { fingerprint: candidate.fingerprint, text: offerToast(candidate) }
}

async function isOpenForOffer($: EngineInterface, turn: TurnEnd): Promise<boolean> {
  return (await $.state.get(offerRef)).value === undefined && isRealPause(turn, await agentStatuses($))
}

async function offerOnce($: EngineInterface, turn: TurnEnd, records: Records): Promise<void> {
  if (!(await isOpenForOffer($, turn))) return
  const offer = await offerToShow($, records)
  if (offer !== undefined) await showOffer($, offer.fingerprint, offer.text)
}

/** The person typed the skill the offer named: that answers it, so it is not logged as ignored. */
export async function noteSkillRun($: EngineInterface, skill: string): Promise<void> {
  const { value: offer } = await $.state.get(offerRef)
  if (offer === undefined || offer.isReviewed || !skillAnswersOffer(skill, offer.fingerprint)) return
  await logImpression($, offer.fingerprint, 'review')
  await $.state.set(offerRef, { ...offer, isReviewed: true })
}

/** Called by the core once it has published, so the inbox reads this session's candidates. */
export async function startInbox($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'quartermaster',
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
  await $.state.set(pressProblemRef, '')
  forgetStoredProposals()
  const records = await refreshRecords($)
  const opened = await $.ui.open({ id: PANE, title: 'Quartermaster' }).catch(() => undefined)

  return opened?.isPlaced === true ? {} : { text: inboxText(records, await currentCandidates($), projectNameOf(await $.session.cwd())) }
}

/** The /quartermaster command and the inbox pane. */
export const registerViews = (on: On): void => {
  on('command.run', { command: 'quartermaster' }, openInbox).catch(() => ({
    text: 'Quartermaster could not open. Its suggestions are files in .claude/quartermaster/proposals/.',
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const content = {
      records: (await $.state.get(recordsRef)).value ?? EMPTY_RECORDS,
      candidates: await currentCandidates($),
      view: (await $.state.get(viewRef)).value ?? {},
      problem: (await $.state.get(pressProblemRef)).value ?? '',
      reason: (await $.state.get(reasonRef)).value ?? '',
    }

    return inboxPane($.ui.resolve(e), content, actionsFor($))
  })
}
