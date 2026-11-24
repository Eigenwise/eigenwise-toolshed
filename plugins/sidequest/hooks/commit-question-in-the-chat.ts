import { SHOW_THE_WHOLE_TEXT, sayOnly } from './chat-ending'
import type { ChatEnding } from './chat-ending'
import { forYouGapLines, parseForYou } from './for-you'
import { lastReviewOutcome } from './frontier'
import { awaitsHumanAnswer, waitsOnHuman } from './human-answers'
import { afterTheProofText, afterTheReviewText, changedParts, hasSayingYesTo, NOTHING_TO_SAY_YES_TO } from './saying-yes-to'
import type { SayingYesTo } from './saying-yes-to'
import type { Ticket } from './tickets'
import { nowWaitingBlocksText } from './waiting-view'
import type { WaitingAround } from './waiting-view'

// What a write that fills in what the person says yes to tells the session to say in the chat, at each of its two
// steps. With the board placed the ticket's view holds it all, above the question, and the chat gets one line.

const LEFT_WAITING_ON_THE_PERSON = /\b(moved|status) needs-you to /

// The yes moves the ticket out of waiting on the person, so a ticket that left it once and waits no more is past it.
export const isPastTheYes = (ticket: Ticket): boolean => !waitsOnHuman(ticket) && ticket.log.some(line => LEFT_WAITING_ON_THE_PERSON.test(line))

export const AFTER_THE_PROOF_POINTER = 'What changed, how it was checked and the hunks that carry the design are on the board (/board opens it). The review still runs.'

const REVIEW_STILL_RUNS = 'The review still runs.'

export const afterTheReviewPointer = (reviewPassed: boolean): string =>
  `${reviewPassed ? 'The review passed' : 'The review is back'}: what it found, the words that go out and the question wait on the board (/board opens it). A letter typed here works too.`

// `waitingBlock` is the ticket's question as the waiting view writes it, empty while nothing is asked yet.
export type CommitQuestion = { parts: SayingYesTo; waitingBlock: string; reviewPassed: boolean; notes: readonly string[] }

const notesBefore = (notes: readonly string[]): string => notes.map(note => `\n\n${note}`).join('')

const afterTheProof = (question: CommitQuestion): ChatEnding => ({
  withBoardPlaced: `${notesBefore(question.notes)}\n\n${sayOnly('one line')}\n\n${AFTER_THE_PROOF_POINTER}`,
  withNoBoard: `${notesBefore(question.notes)}\n\n${SHOW_THE_WHOLE_TEXT}\n\n${[afterTheProofText(question.parts), REVIEW_STILL_RUNS].filter(part => part !== '').join('\n\n')}`,
})

const afterTheReview = (question: CommitQuestion): ChatEnding => ({
  withBoardPlaced: `${notesBefore(question.notes)}\n\n${sayOnly('one line')}\n\n${afterTheReviewPointer(question.reviewPassed)}`,
  withNoBoard: `${notesBefore(question.notes)}\n\n${SHOW_THE_WHOLE_TEXT}\n\n${[afterTheReviewText(question.parts), question.waitingBlock].filter(part => part !== '').join('\n\n')}`,
})

export const chatAfterSayingYesTo = (question: CommitQuestion): ChatEnding =>
  question.waitingBlock === '' ? afterTheProof(question) : afterTheReview(question)

const sayingYesToOf = (ticket: Ticket | undefined): SayingYesTo => (ticket === undefined ? NOTHING_TO_SAY_YES_TO : parseForYou(ticket.forYou).sayingYesTo)

const startedWaiting = (ticket: Ticket, before: Ticket | undefined): boolean => awaitsHumanAnswer(ticket) && !(before !== undefined && awaitsHumanAnswer(before))

// A write that filled in a step, or asked the question beside what was filled in. Words changed after the yes are
// said in the closing message instead, from the ticket's log.
const isCommitQuestionWrite = (ticket: Ticket, before: Ticket | undefined): boolean => {
  const now = sayingYesToOf(ticket)
  if (isPastTheYes(ticket) || !hasSayingYesTo(now)) return false

  return changedParts(sayingYesToOf(before), now).length > 0 || startedWaiting(ticket, before)
}

export const commitQuestionAmong = (written: readonly Ticket[], before: ReadonlyMap<string, Ticket>): Ticket | undefined =>
  written.find(ticket => isCommitQuestionWrite(ticket, before.get(ticket.id)))

export const commitQuestionOf = (ticket: Ticket, tickets: readonly Ticket[], around: WaitingAround): CommitQuestion => ({
  parts: sayingYesToOf(ticket),
  waitingBlock: waitsOnHuman(ticket) ? nowWaitingBlocksText([ticket], tickets, around) : '',
  reviewPassed: lastReviewOutcome(ticket) === 'pass',
  notes: waitsOnHuman(ticket) ? forYouGapLines([ticket]) : [],
})
