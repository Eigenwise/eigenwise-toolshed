import { A_DAY, daysWords, lastTouchedOf, millisecondsSince } from './ages'
import { isFromEarlierWork } from './earlier-work'
import { pullRequestWords, ticketHandle } from './branch-and-issue'
import { alsoYoursText, forYouGapLines, optionLetter, optionText, parseForYou, WHAT_REACHES_THE_PERSON } from './for-you'
import type { AlsoYours } from './for-you'
import type { ForYou } from './for-you'
import { awaitsHumanAnswer, isAnswerWithSession, waitsOnHuman } from './human-answers'
import { headedTickets, NO_STORIES, piecesOfWork, spansSeveralPieces, ticketNameUnder } from './pieces-of-work'
import type { BoardWork, HeadedTickets, StoriesAndCheckout } from './pieces-of-work'
import { hasComeBack, NO_PULL_REQUEST_STATES, pullRequestStateWords } from './team-work'
import type { PullRequestState, PullRequestStates } from './team-work'
import { idNumber, inIdOrder, oneLine } from './tickets'
import type { Story, Ticket } from './tickets'

const SETTLED_STATUSES = ['done', 'parked']

const BLOCK_INDENT = '   '

const isOpen = (ticket: Ticket): boolean => !SETTLED_STATUSES.includes(ticket.status)

const ticketsBlockedBy = (id: string, tickets: readonly Ticket[]): Ticket[] => tickets.filter(ticket => ticket.blockedBy.includes(id))

// Directly or through others: a decision that holds up a chain holds up the whole chain.
const openTicketsHeldUpBy = (id: string, tickets: readonly Ticket[]): number => {
  const reached = new Set<string>()
  const queue = [id]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const unseen = ticketsBlockedBy(next, tickets).filter(ticket => !reached.has(ticket.id) && ticket.id !== id)
    unseen.forEach(ticket => reached.add(ticket.id))
    queue.push(...unseen.map(ticket => ticket.id))
  }

  return tickets.filter(ticket => reached.has(ticket.id) && isOpen(ticket)).length
}

export const mostBlockingFirst = (waiting: readonly Ticket[], tickets: readonly Ticket[]): Ticket[] => {
  const heldUp = new Map(waiting.map(ticket => [ticket.id, openTicketsHeldUpBy(ticket.id, tickets)]))
  const heldUpBy = (ticket: Ticket): number => heldUp.get(ticket.id) ?? 0

  return [...waiting].sort((left, right) => heldUpBy(right) - heldUpBy(left) || idNumber(left.id) - idNumber(right.id))
}

const isBareLetter = (text: string): boolean => /^[a-z]\.?$/i.test(text)

const recommendedIndex = (forYou: ForYou): number => {
  const recommended = forYou.recommended.trim().toLowerCase()
  if (isBareLetter(recommended)) return recommended.charCodeAt(0) - 'a'.charCodeAt(0)

  return forYou.options.findIndex(option => option.label.trim() !== '' && recommended.startsWith(option.label.trim().toLowerCase()))
}

export const recommendedLetter = (forYou: ForYou): string | undefined => {
  const index = recommendedIndex(forYou)

  return index >= 0 && index < forYou.options.length ? optionLetter(index) : undefined
}

// A bare letter means nothing to someone glancing at a list, so it is read as the option it names.
export const recommendedAnswer = (forYou: ForYou): string => {
  const recommended = oneLine(forYou.recommended)
  const named = isBareLetter(recommended) ? forYou.options[recommendedIndex(forYou)]?.label : undefined

  return named === undefined ? recommended : oneLine(named)
}

const recommendedLine = (forYou: ForYou): string => {
  const letter = recommendedLetter(forYou)
  const recommended = forYou.recommended.trim()
  if (recommended === '') return ''
  if (letter === undefined) return `Recommended: ${recommended}`

  return isBareLetter(recommended) ? `Recommended: ${letter}` : `Recommended: ${letter} (${recommended})`
}

const labelled = (label: string, text: string): string => (text.trim() === '' ? '' : `${label}: ${text.trim()}`)

// Seen in a real run: one question numbered 1 beside extras numbered 1 to 3 made an answer like 1A, and do 1 that read
// two ways. Alone, a question has no number; among several, its extras carry its number too, like 2.1.
type QuestionPlace ={ number?: number; isForTheChat?: boolean }

const extraName = (index: number, place: QuestionPlace): string => (place.number === undefined ? `${index + 1}` : `${place.number}.${index + 1}`)

// The chat already holds the context above the block; why it waits and what silence does are for a cold read.
const forColdReadOnly = (place: QuestionPlace, line: string): string => (place.isForTheChat === true ? '' : line)

export const forYouLines = (forYou: ForYou, place: QuestionPlace = {}): string[] =>
  [
    forYou.question.trim(),
    forColdReadOnly(place, labelled('Why now', forYou.whyNow)),
    ...forYou.options.map((option, index) => `${optionLetter(index)}. ${optionText(option)}`),
    recommendedLine(forYou),
    forColdReadOnly(place, labelled('If you never answer', forYou.ifUnanswered)),
    labelled('Steps', forYou.steps),
    ...alsoYoursLines(forYou.alsoYours, place),
  ].filter(line => line !== '')

const alsoYoursLines = (items: readonly AlsoYours[], place: QuestionPlace): string[] =>
  items.length === 0 ? [] : ['Also yours, say which to do too:', ...items.map((item, index) => `${extraName(index, place)}. ${alsoYoursText(item)}`)]

const numberPrefix = (place: QuestionPlace): string => (place.number === undefined ? '' : `${place.number}`)

const answerWithoutOptions = (place: QuestionPlace, handle: string): string =>
  place.number === undefined
    ? `To answer: done, or what you found. Ticket ${handle}.`
    : `To answer: ${place.number} done, or ${place.number} and what you found. Ticket ${handle}.`

const extrasExample = (forYou: ForYou, place: QuestionPlace): string =>
  forYou.alsoYours.map((_, index) => extraName(index, place)).slice(0, 2).join(' and ')

const alsoDoHint = (forYou: ForYou, place: QuestionPlace, answer: string): string =>
  forYou.alsoYours.length === 0 ? '' : `, plus any extras to do too, like ${answer}, plus ${extrasExample(forYou, place)}`

const letterForm = (place: QuestionPlace): string => (place.number === undefined ? 'a letter' : `${place.number} and a letter`)

const howToAnswer = (place: QuestionPlace, forYou: ForYou, handle: string): string => {
  if (forYou.options.length === 0) return answerWithoutOptions(place, handle)
  const answer = `${numberPrefix(place)}${recommendedLetter(forYou) ?? 'A'}`

  return `To answer: ${letterForm(place)}, like ${answer}${alsoDoHint(forYou, place, answer)}. Ticket ${handle}.`
}

const indented = (line: string): string => line.split('\n').map(part => `${BLOCK_INDENT}${part}`).join('\n')

// Read from the ticket's own stamps. Under a day says nothing: the question is from today.
const waitedLines = (ticket: Ticket, now: number | undefined): string[] => {
  const waited = now === undefined ? Number.NaN : millisecondsSince(lastTouchedOf(ticket), now)

  return waited >= A_DAY ? [`Waiting ${daysWords(waited)}.`] : []
}

const headLine = (question: string, place: QuestionPlace): string => (place.number === undefined ? question : `${place.number}. ${question}`)

const questionBlockText = (ticket: Ticket, place: QuestionPlace, now?: number, name = ticketHandle(ticket)): string => {
  const forYou = parseForYou(ticket.forYou)
  const [question = '', ...rest] = forYouLines(forYou, place)
  const body = [...waitedLines(ticket, now), ...rest, howToAnswer(place, forYou, name)].map(indented)

  return [headLine(question, place), ...body].join('\n')
}

const hasQuestion = (ticket: Ticket): boolean => parseForYou(ticket.forYou).question.trim() !== ''

const writtenWaiting = (tickets: readonly Ticket[]): Ticket[] =>
  mostBlockingFirst(tickets.filter(awaitsHumanAnswer), tickets).filter(hasQuestion)

// The view is pasted to the person as it is, so the model's own hint is marked to stay out of it.
export const NOT_TO_PASTE ='For the session, not to paste:'

const unwrittenLine = (unwritten: readonly Ticket[]): string =>
  unwritten.length === 0
    ? ''
    : `${NOT_TO_PASTE} waiting, not yet written for a cold read: ${unwritten.map(ticket => `${ticket.id} (${ticket.title})`).join(', ')}. Patch each with forYou.`

const answeredTicketNames = (tickets: readonly Ticket[]): string[] =>
  inIdOrder(tickets.filter(ticket => waitsOnHuman(ticket) && isAnswerWithSession(ticket))).map(ticket => `${ticket.id} (${oneLine(ticket.title)})`)

const answeredStoryNames = (stories: readonly Story[]): string[] =>
  stories.flatMap(story => [
    ...(story.decisionPicksSent === undefined ? [] : [`the decisions on ${story.id} (${oneLine(story.title)})`]),
    ...(story.playbackAnswerSent === undefined ? [] : [`the yes on ${story.id} (${oneLine(story.title)})`]),
  ])

// Answered on the board, so it is in the chat as the person's message and waits on the session, not on them.
const answeredOnTheBoardLine = (tickets: readonly Ticket[], stories: readonly Story[]): string => {
  const names = [...answeredTicketNames(tickets), ...answeredStoryNames(stories)]

  return names.length === 0 ? '' : `${NOT_TO_PASTE} answered on the board, so the answer is with you to record, or ask again: ${names.join(', ')}.`
}

type PullRequestOfTicket = { ticket: Ticket; state: PullRequestState }

const withPullRequests = (tickets: readonly Ticket[], pullRequests: PullRequestStates): PullRequestOfTicket[] =>
  inIdOrder(tickets).flatMap(ticket => {
    const state = pullRequests.get(ticket.id)

    return state === undefined ? [] : [{ ticket, state }]
  })

// A ticket already waiting on the person keeps its own question; its pull request is said with the others.
const hasComeBackToThePerson = ({ ticket, state }: PullRequestOfTicket): boolean => hasComeBack(state) && !waitsOnHuman(ticket)

const pullRequestPlace = ({ ticket, state }: PullRequestOfTicket): string => state.address || pullRequestWords(ticket.pullRequest ?? `#${state.number}`)

const cameBackLines = (cameBack: PullRequestOfTicket): string[] => [
  `The pull request for "${cameBack.ticket.title}" came back with ${pullRequestStateWords(cameBack.state)}. Take the work up again?`,
  cameBack.ticket.status === 'done' ? 'Why now: the work was marked done here, and this came in since.' : '',
  `Steps: open ${pullRequestPlace(cameBack)}, read what came back, and say whether to take the work up again.`,
]

const withItsPullRequest = ({ ticket, state }: PullRequestOfTicket): Ticket => ({
  ...ticket,
  pullRequest: ticket.pullRequest ?? (state.address || `#${state.number}`),
})

const cameBackBlock = (cameBack: PullRequestOfTicket, place: QuestionPlace, name: string): string => {
  const [question = '', ...rest] = cameBackLines(cameBack).filter(line => line !== '')
  const body = [...rest, answerWithoutOptions(place, name)].map(indented)

  return [headLine(question, place), ...body].join('\n')
}

const standingLine = (pullRequest: PullRequestOfTicket): string[] => {
  const words = pullRequestStateWords(pullRequest.state)

  return words === '' ? [] : [`- "${pullRequest.ticket.title}", pull request #${pullRequest.state.number}: ${words}.`]
}

const standingPart = (standing: readonly PullRequestOfTicket[]): string => {
  const lines = standing.flatMap(standingLine)

  return lines.length === 0 ? '' : ['Where the pull requests stand:', ...lines].join('\n')
}

const NOTHING_WAITS = 'Nothing waits on you.'

const EARLIER_WORK_HEADING = 'Still waiting on you from earlier sessions:'

// Only when this session's own work waits on the person: otherwise the view is the whole list, as it always was.
const isTicketFromEarlierWork = (ticket: Ticket, touched: ReadonlySet<string>, now: number | undefined): boolean =>
  now !== undefined && isFromEarlierWork(ticket.id, lastTouchedOf(ticket), touched, now)

const earlierWorkSplit = (written: readonly Ticket[], touched: ReadonlySet<string>, now: number | undefined): { current: Ticket[]; earlier: Ticket[] } => {
  const sessionWaits = written.some(ticket => touched.has(ticket.id))
  const earlier = sessionWaits ? written.filter(ticket => isTicketFromEarlierWork(ticket, touched, now)) : []

  return { current: written.filter(ticket => !earlier.includes(ticket)), earlier }
}

const earlierWorkLine = (ticket: Ticket, now: number | undefined): string =>
  `- ${ticket.id} ${oneLine(ticket.title)}, waiting ${daysWords(millisecondsSince(lastTouchedOf(ticket), now ?? Number.NaN))}`

const earlierWorkPart = (earlier: readonly Ticket[], now: number | undefined): string =>
  earlier.length === 0 ? '' : [EARLIER_WORK_HEADING, ...earlier.map(ticket => earlierWorkLine(ticket, now))].join('\n')

type NameOfTicket = (ticket: Ticket) => string

// Numbered only once the view knows its order, so the number a person answers with is the one they read.
type WaitingBlock = { ticket: Ticket; write: (place: QuestionPlace, nameOf: NameOfTicket) => string }

const questionBlock = (ticket: Ticket, now: number | undefined): WaitingBlock => ({
  ticket,
  write: (place, nameOf) => questionBlockText(ticket, place, now, nameOf(ticket)),
})

const pullRequestBlock = (cameBack: PullRequestOfTicket): WaitingBlock => ({
  ticket: cameBack.ticket,
  write: (place, nameOf) => cameBackBlock(cameBack, place, nameOf(withItsPullRequest(cameBack))),
})

type BlockUnderHeading = { block: WaitingBlock; group: HeadedTickets }

const inPieceOrder = (blocks: readonly WaitingBlock[], groups: readonly HeadedTickets[]): BlockUnderHeading[] =>
  groups.flatMap(group => blocks.filter(block => group.tickets.includes(block.ticket)).map(block => ({ block, group })))

type NumberedBlock = { ticket: Ticket; group?: HeadedTickets; text: string }

type Reading = { isForTheChat: boolean; count: number }

const placeOf = (index: number, reading: Reading): QuestionPlace => ({
  isForTheChat: reading.isForTheChat,
  ...(reading.count === 1 ? {} : { number: index + 1 }),
})

const numberedByPiece = (blocks: readonly WaitingBlock[], groups: readonly HeadedTickets[], reading: Reading): NumberedBlock[] =>
  inPieceOrder(blocks, groups).map(({ block, group }, index) => ({
    ticket: block.ticket,
    group,
    text: block.write(placeOf(index, reading), ticket => ticketNameUnder(ticket, group.piece)),
  }))

const numberedInOrder = (blocks: readonly WaitingBlock[], reading: Reading): NumberedBlock[] =>
  blocks.map((block, index) => ({ ticket: block.ticket, text: block.write(placeOf(index, reading), ticketHandle) }))

type NumberedWaiting = { isByPiece: boolean; numbered: NumberedBlock[] }

const numberedWaiting = (blocks: readonly WaitingBlock[], board: BoardWork, isForTheChat = false): NumberedWaiting => {
  const grouped = piecesOfWork(blocks.map(block => block.ticket), board)
  const reading = { isForTheChat, count: blocks.length }

  return spansSeveralPieces(grouped)
    ? { isByPiece: true, numbered: numberedByPiece(blocks, headedTickets(grouped), reading) }
    : { isByPiece: false, numbered: numberedInOrder(blocks, reading) }
}

const headingAbove = (numbered: readonly NumberedBlock[], index: number): string[] => {
  const group = numbered[index]?.group

  return group === undefined || numbered[index - 1]?.group === group ? [] : [group.heading]
}

const withHeadings = (numbered: readonly NumberedBlock[]): string[] =>
  numbered.flatMap((block, index) => [...headingAbove(numbered, index), block.text])

type WaitingMoment = BoardWork & { now?: number }

const questionsAndReturns = (moment: WaitingMoment, cameBack: readonly PullRequestOfTicket[]): { blocks: WaitingBlock[]; earlier: Ticket[] } => {
  const { current, earlier } = earlierWorkSplit(writtenWaiting(moment.tickets), moment.touched, moment.now)

  return { blocks: [...current.map(ticket => questionBlock(ticket, moment.now)), ...cameBack.map(pullRequestBlock)], earlier }
}

const MOST_BLOCKING_LEAD = 'Waiting on you, most blocking first:'
const BY_PIECE_LEAD = 'Waiting on you, by piece of work:'

export const waitingText = (
  tickets: readonly Ticket[],
  pullRequests: PullRequestStates = NO_PULL_REQUEST_STATES,
  now?: number,
  touched: ReadonlySet<string> = new Set(),
  storiesAndCheckout: StoriesAndCheckout = NO_STORIES,
): string => {
  const board = { ...storiesAndCheckout, tickets, touched }
  const waiting = mostBlockingFirst(tickets.filter(awaitsHumanAnswer), tickets)
  const withStates = withPullRequests(tickets, pullRequests)
  const cameBack = withStates.filter(hasComeBackToThePerson)
  const { blocks: waitingBlocks, earlier } = questionsAndReturns({ ...board, now }, cameBack)
  const { isByPiece, numbered } = numberedWaiting(waitingBlocks, board)
  const blocks = withHeadings(numbered)
  const blocksLead = isByPiece ? BY_PIECE_LEAD : MOST_BLOCKING_LEAD
  const lead = blocks.length > 0 || earlier.length > 0 ? blocksLead : ''
  const nothing = waiting.length + cameBack.length === 0 ? NOTHING_WAITS : ''
  const unwritten = unwrittenLine(waiting.filter(ticket => !hasQuestion(ticket)))
  const standing = standingPart(withStates.filter(pullRequest => !cameBack.includes(pullRequest)))
  const answered = answeredOnTheBoardLine(tickets, storiesAndCheckout.stories)

  return [nothing, lead, ...blocks, earlierWorkPart(earlier, now), standing, unwritten, answered].filter(part => part !== '').join('\n\n')
}

// What the waiting view would be read with at the moment of a write. The tickets this session touched include the
// ones the write is about.
export type WaitingAround = StoriesAndCheckout & { touched: ReadonlySet<string>; now?: number }

const NOTHING_AROUND: WaitingAround = { ...NO_STORIES, touched: new Set() }

export const waitingAroundWrite = (
  { stories, checkedOutBranch }: StoriesAndCheckout,
  touchedBefore: ReadonlySet<string>,
  writtenIds: Iterable<string>,
  stamp: string,
): WaitingAround => ({
  stories,
  ...(checkedOutBranch === undefined ? {} : { checkedOutBranch }),
  touched: new Set([...touchedBefore, ...writtenIds]),
  now: Date.parse(stamp),
})

// Numbered and named as the waiting view numbers and names them at this moment, so an answer like 2A taken from the
// note lands on the same ticket in the view. A pull request that came back is not known at a write, so none count here.
const nowWaitingBlocks = (ids: ReadonlySet<string>, tickets: readonly Ticket[], around: WaitingAround): string[] => {
  const moment = { ...around, tickets }
  const { numbered } = numberedWaiting(questionsAndReturns(moment, []).blocks, moment, true)

  return withHeadings(numbered.filter(block => ids.has(block.ticket.id)))
}

export const nowWaitingBlocksText = (nowWaiting: readonly Ticket[], tickets: readonly Ticket[], around: WaitingAround): string =>
  nowWaitingBlocks(new Set(nowWaiting.map(ticket => ticket.id)), tickets, around).join('\n\n')

const SHOW_AS_IT_IS = 'Show the person this as it is:'

const blocksToShow = (blocks: readonly string[]): string[] => (blocks.length === 0 ? [] : [SHOW_AS_IT_IS, blocks.join('\n\n')])

// Read at the moment a session parks something, which is the one place the rule is in front of it when it matters.
export const nowWaitingNote = (nowWaiting: readonly Ticket[], tickets: readonly Ticket[], around: WaitingAround = NOTHING_AROUND): string => {
  if (nowWaiting.length === 0) return ''
  const blocks = nowWaitingBlocks(new Set(nowWaiting.map(ticket => ticket.id)), tickets, around)

  return ['', WHAT_REACHES_THE_PERSON, ...forYouGapLines(nowWaiting), ...blocksToShow(blocks)].join('\n')
}
