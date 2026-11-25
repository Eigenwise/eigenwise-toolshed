import { expect, test } from 'claude-code/testing'

import type { BoardCard } from '../types'
import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import { closingReportText } from './closing-report'
import type { BoardFiles } from './store'
import { summarize } from './summary'
import { applyStoryPatch, newStory, newTicket } from './tickets'
import type { Story, Ticket } from './tickets'
import { SIDEQUEST_TOOLS } from './tool-specs'
import { waitingText } from './waiting-view'
import { whatThePersonCouldDo } from './what-can-move'
import { bandLine, boardCards, doingTicketsIn } from './views/board-view'
import { boardPaneLines, cardsBeingChecked, paneLinesAsText } from './views/pane-sections'
import type { PaneContent } from './views/pane-sections'

const NOW = Date.parse('2026-11-25T10:00:00Z')
const STAMP = '2026-11-25T10:00Z'
const DAY = 24 * 60 * 60 * 1000

const stampAgo = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString().slice(0, 16) + 'Z'

const ticketOf = (id: string, title: string, status: string, extra: Partial<Ticket> = {}): Ticket => ({
  ...newTicket(id, { title, status, mode: status === 'needs-you' ? 'hitl' : 'afk', forYou: status === 'needs-you' ? `Question: What about ${title}?` : '' }, stampAgo(DAY / 24)),
  ...extra,
})

const planWithOpenDecisions = (): Story => ({
  ...newStory('SQ-S1', 'Plan the retries', STAMP),
  inShort: 'Retry with a backoff.',
  questions: [
    { question: 'Which backoff?', recommended: 'Exponential', otherCosts: 'Linear is simpler' },
    { question: 'How many tries?', recommended: 'Five', otherCosts: 'Three is faster' },
  ],
})

const noActivity = { agents: {}, runs: {}, waits: {}, doingTickets: [], returnedTickets: [] }

const paneFor = (cards: readonly BoardCard[]): PaneContent => ({
  cards,
  running: [],
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: [],
  worktreeCount: 0,
  touchedHere: new Set(),
  showsIntro: false,
  columns: 100,
  now: NOW,
  whatYouCouldDo: [],
})

const filesOf = (tickets: Ticket[], stories: Story[] = []): BoardFiles => ({
  config: DEFAULT_BOARD_CONFIG,
  configText: undefined,
  tickets,
  stories,
  checkedOutBranch: 'main',
})

const textOfView = (view: string, files: BoardFiles): string => {
  const answer = answerBoardView({ view }, files, STAMP)

  return 'text' in answer ? answer.text : answer.refusal
}

test('a plan with open decisions and no needs-you ticket makes the band say something waits on the person', () => {
  const summary = summarize([], new Set(), NOW, [planWithOpenDecisions()])

  expect(summary.needsYou).toBe(0)
  expect(summary.plansWaiting).toBe(1)
  expect(bandLine(summary, noActivity, 120).warnings).toBe('1 plan needs you')
  expect(bandLine(summary, noActivity, 10).warnings).toBe('1 needs you')
  expect(textOfView('summary', filesOf([], [planWithOpenDecisions()]))).toContain('1 plan has decisions or a yes waiting on the person')
  expect(waitingText([], undefined, NOW, new Set(), { stories: [planWithOpenDecisions()] })).toContain('- SQ-S1 Plan the retries: 2 decisions.')
})

test('a plan whose decisions were sent from the board no longer warns in the band', () => {
  const sent: Story = { ...planWithOpenDecisions(), decisionPicksSent: ['recommended', 'recommended'] }

  expect(summarize([], new Set(), NOW, [sent]).plansWaiting).toBe(0)
})

test('a needs-you ticket on another branch than the checked out one is counted by the band, the summary, the pane and the waiting view', () => {
  const elsewhere = ticketOf('SQ-7', 'Pick the queue', 'needs-you', { branch: 'feature/queue' })
  const summary = summarize([elsewhere], new Set(), NOW)
  const cards = boardCards([elsewhere], DEFAULT_BOARD_CONFIG, undefined, { stories: [], checkedOutBranch: 'main', touched: new Set() })

  expect(summary.needsYou).toBe(1)
  expect(bandLine(summary, noActivity, 120).warnings).toBe('1 ticket needs you')
  expect(textOfView('summary', filesOf([elsewhere]))).toContain('1 waiting on you')
  expect(paneLinesAsText(boardPaneLines(paneFor(cards)))).toContain('Waits on you')
  expect(paneLinesAsText(boardPaneLines(paneFor(cards)))).toContain('What about Pick the queue?')
  expect(waitingText([elsewhere], undefined, NOW, new Set(), { stories: [], checkedOutBranch: 'main' })).toContain('What about Pick the queue?')
})

test('a decision written for an open question takes that question off the plan in the same write', () => {
  const written = applyStoryPatch(
    planWithOpenDecisions(),
    { decisions: [{ question: 'which backoff?', answer: 'Exponential', decidedBy: 'human' }] },
    STAMP,
  )

  expect(written.questions.map(question => question.question)).toEqual(['How many tries?'])
  expect(written.decisions).toContain('which backoff? Answer: Exponential')
})

test('answering every open question with decisions leaves the plan with nothing waiting, and sent picks are cleared', () => {
  const sent: Story = { ...planWithOpenDecisions(), decisionPicksSent: ['recommended', 'recommended'], decisionDaySent: '2026-11-25' }
  const written = applyStoryPatch(
    sent,
    {
      decisions: [
        { question: 'Which backoff?', answer: 'Exponential', decidedBy: 'human' },
        { question: 'How many tries?', answer: 'Five', decidedBy: 'human' },
      ],
    },
    STAMP,
  )

  expect(written.questions).toEqual([])
  expect(written.decisionPicksSent).toBeUndefined()
  expect(summarize([], new Set(), NOW, [written]).plansWaiting).toBe(0)
})

test('a decision for no open question leaves the questions alone, and questions written in the same call win', () => {
  const plan = planWithOpenDecisions()
  const unrelated = applyStoryPatch(plan, { decisions: [{ question: 'Which logger?', answer: 'Pino', decidedBy: 'human' }] }, STAMP)
  const explicit = applyStoryPatch(plan, { decisions: [{ question: 'Which backoff?', answer: 'Exponential', decidedBy: 'human' }], questions: plan.questions }, STAMP)

  expect(unrelated.questions).toEqual(plan.questions)
  expect(explicit.questions).toEqual(plan.questions)
})

test('the ticket tool says a decision takes its open question off the plan', () => {
  const description = JSON.stringify(SIDEQUEST_TOOLS.find(tool => tool.name === 'ticket'))

  expect(description).toContain('takes that question off the list in the same write')
})

test('the band counts as being checked the tickets the pane lists under that name, not the interrupted or week-old ones', () => {
  const built = (id: string, extra: Partial<Ticket> = {}): Ticket => ticketOf(id, `Built ${id}`, 'review', extra)
  const tickets = [built('SQ-1'), built('SQ-2'), built('SQ-3'), built('SQ-4', { updated: '2026-11-10', log: [`${stampAgo(10 * DAY)} moved to review`] })]
  const cards = boardCards(tickets, DEFAULT_BOARD_CONFIG).map(card => (card.id === 'SQ-2' ? { ...card, interrupted: 'no run in this session' } : card))
  const content = paneFor(cards)
  const section = paneLinesAsText(boardPaneLines(content)).split('Being checked\n')[1]?.split('\n\n')[0] ?? ''
  const beingChecked = cardsBeingChecked(content).map(card => card.id)

  expect(beingChecked).toEqual(['SQ-1', 'SQ-3'])
  expect(section.split('\n').map(row => /SQ-\d/.exec(row)?.[0])).toEqual(beingChecked)
  expect(bandLine(summarize(tickets, new Set(), NOW), { ...noActivity, beingCheckedTickets: beingChecked }, 120).counts).toBe('2 tickets being checked')
})

const hitlTicket = (id: string, status: string): Ticket =>
  ticketOf(id, `Look at ${id}`, status, { mode: 'hitl', kind: 'review', forYou: `Question: Is ${id} right?\n\nOptions:\n- A. Yes\n- B. No\n\nRecommended: A` })

test('a ticket the person works with themselves that is ready, in progress or built waits on them in all four places', () => {
  const tickets = [hitlTicket('SQ-1', 'ready'), hitlTicket('SQ-2', 'doing'), hitlTicket('SQ-3', 'review')]
  const touched = new Set(['SQ-1', 'SQ-2', 'SQ-3'])
  const summary = summarize(tickets, touched, NOW)
  const paneText = paneLinesAsText(boardPaneLines({ ...paneFor(boardCards(tickets, DEFAULT_BOARD_CONFIG)), touchedHere: touched }))
  const waitsSection = paneText.split('Waits on you')[1]?.split('\n\n')[0] ?? ''
  const waitingView = waitingText(tickets, undefined, NOW, touched)

  expect(summary.needsYou).toBe(3)
  expect(bandLine(summary, noActivity, 120).warnings).toBe('3 tickets need you')
  expect(textOfView('summary', filesOf(tickets))).toContain('3 waiting on you')
  for (const id of ['SQ-1', 'SQ-2', 'SQ-3']) {
    expect(waitsSection).toContain(`Is ${id} right?`)
    expect(waitingView).toContain(`Is ${id} right?`)
  }
})

test('a plan that has waited more than a week for its yes counts in the band and the summary as the pane and the waiting view count it', () => {
  const proposed = ticketOf('SQ-1', 'Proposed one', 'ready', { story: 'SQ-S1' })
  const plan: Story = { ...newStory('SQ-S1', 'Old plan', stampAgo(9 * DAY)), inShort: 'Retry.', awaitsYes: true }
  const summary = summarize([proposed], new Set(), NOW, [plan])
  const summaryView = textOfView('summary', filesOf([proposed], [plan]))

  expect(summary.plansWaiting).toBe(1)
  expect(bandLine(summary, noActivity, 120).warnings).toBe('1 plan needs you')
  expect(summaryView).toContain('1 plan has decisions or a yes waiting on the person')
  expect(summaryView).toContain('The waiting view')
  expect(waitingText([proposed], undefined, NOW, new Set(), { stories: [plan] })).toContain('- SQ-S1 Old plan: its yes on the proposed tickets.')
})

test('an 80 column band names every ticket, plan and earlier-session question that waits on the person, in full', () => {
  const earlier = ticketOf('SQ-9', 'Pick the limit', 'needs-you', { updated: '2026-11-21', log: [`${stampAgo(4 * DAY)} moved to needs-you`] })
  const summary = summarize([earlier], new Set(), NOW, [planWithOpenDecisions()])
  const withReadyTickets = { ...summary, ready: 2 }

  expect(summary.needsYouFromEarlierWork).toBe(1)
  expect(bandLine(summary, noActivity, 80)).toEqual({ warnings: '1 plan needs you, 1 waiting on you from earlier sessions', counts: '' })
  expect(bandLine(withReadyTickets, noActivity, 80)).toEqual({ warnings: '1 plan needs you, 1 waiting on you from earlier sessions', counts: '' })
})

test('a decision for one open question keeps what the person sent for the others, and drops only the sent pick of the one it took off', () => {
  const sent: Story = {
    ...planWithOpenDecisions(),
    decisionPicksSent: ['recommended', 'other'],
    decisionWordsSent: 'both fine',
    decisionDaySent: '2026-11-25',
  }
  const written = applyStoryPatch(sent, { decisions: [{ question: 'Which backoff?', answer: 'Exponential', decidedBy: 'human' }] }, STAMP)

  expect(written.questions.map(question => question.question)).toEqual(['How many tries?'])
  expect(written.decisionPicksSent).toEqual(['other'])
  expect(written.decisionWordsSent).toBe('both fine')
  expect(written.decisionDaySent).toBe('2026-11-25')
  expect(summarize([], new Set(), NOW, [written]).plansWaiting).toBe(0)
})

test('a decision matches an open question ignoring case, spacing and a closing question mark, and takes off one question only', () => {
  const twice: Story = {
    ...planWithOpenDecisions(),
    questions: [
      { question: 'Which backoff?', recommended: 'Exponential', otherCosts: 'Linear' },
      { question: 'Which  backoff', recommended: 'Exponential', otherCosts: 'Linear' },
      { question: 'How many tries?', recommended: 'Five', otherCosts: 'Three' },
    ],
  }
  const written = applyStoryPatch(twice, { decisions: [{ question: 'which backoff', answer: 'Exponential', decidedBy: 'human' }] }, STAMP)
  const differentWord = applyStoryPatch(twice, { decisions: [{ question: 'Which retry backoff?', answer: 'Exponential', decidedBy: 'human' }] }, STAMP)

  expect(written.questions.map(question => question.question)).toEqual(['Which  backoff', 'How many tries?'])
  expect(differentWord.questions).toEqual(twice.questions)
})

test('the summary counts as being checked the tickets the pane lists under that name, not the interrupted ones', () => {
  const tickets = [ticketOf('SQ-1', 'Built 1', 'review'), ticketOf('SQ-2', 'Built 2', 'review'), ticketOf('SQ-3', 'Built 3', 'review')]
  const answer = answerBoardView({ view: 'summary' }, filesOf(tickets), STAMP, new Map([['SQ-2', 'no run in this session']]))

  expect('text' in answer ? answer.text : answer.refusal).toContain('2 being checked')
})

test('the ticket tool says which questions a decision takes off and what happens to the picks', () => {
  const description = JSON.stringify(SIDEQUEST_TOOLS.find(tool => tool.name === 'ticket'))

  expect(description).toContain('ignoring case, spacing and a closing question mark')
  expect(description).toContain('One decision takes off one question')
  expect(description).toContain('The picks and words the person sent from the board for the questions still open are kept')
})

const waitingInFourPlaces = (tickets: Ticket[], stories: Story[] = []): { summary: number; band: string; pane: string; waitingView: string; summaryView: string } => {
  const touched = new Set(tickets.map(ticket => ticket.id))
  const summary = summarize(tickets, touched, NOW, stories)
  const cards = boardCards(tickets, DEFAULT_BOARD_CONFIG, new Map(), { stories, touched })
  const paneText = paneLinesAsText(boardPaneLines({ ...paneFor(cards), touchedHere: touched }))

  return {
    summary: summary.needsYou,
    band: bandLine(summary, noActivity, 120).warnings,
    pane: paneText.split('Waits on you')[1]?.split('\n\n')[0] ?? '',
    waitingView: waitingText(tickets, undefined, NOW, touched, { stories }),
    summaryView: textOfView('summary', filesOf(tickets, stories)),
  }
}

test('a checkpoint behind work that is not built waits on nobody in any of the four places, and on the person in all four once it is built', () => {
  const checkpoint = { ...hitlTicket('SQ-2', 'ready'), blockedBy: ['SQ-1'] }
  const behindUnbuiltWork = waitingInFourPlaces([ticketOf('SQ-1', 'Build the retry', 'doing'), checkpoint])
  const behindBuiltWork = waitingInFourPlaces([ticketOf('SQ-1', 'Build the retry', 'review'), checkpoint])

  expect(behindUnbuiltWork.summary).toBe(0)
  expect(behindUnbuiltWork.band).toBe('')
  expect(behindUnbuiltWork.pane).not.toContain('Is SQ-2 right?')
  expect(behindUnbuiltWork.waitingView).not.toContain('Is SQ-2 right?')
  expect(behindUnbuiltWork.summaryView).toContain('0 waiting on you')
  expect(behindBuiltWork.summary).toBe(1)
  expect(behindBuiltWork.band).toBe('1 ticket needs you')
  expect(behindBuiltWork.pane).toContain('Is SQ-2 right?')
  expect(behindBuiltWork.waitingView).toContain('Is SQ-2 right?')
  expect(behindBuiltWork.summaryView).toContain('1 waiting on you')
})

test('a checkpoint still in the inbox, and one a plan only proposes, wait on nobody in any of the four places', () => {
  const plan: Story = { ...newStory('SQ-S1', 'Plan the retries', STAMP), inShort: 'Retry.', awaitsYes: true }
  const proposed = { ...hitlTicket('SQ-1', 'ready'), story: 'SQ-S1' }
  const places = waitingInFourPlaces([proposed, hitlTicket('SQ-2', 'inbox')], [plan])

  expect(places.summary).toBe(0)
  expect(places.band).toBe('1 plan needs you')
  for (const id of ['SQ-1', 'SQ-2']) {
    expect(places.pane).not.toContain(`Is ${id} right?`)
    expect(places.waitingView).not.toContain(`Is ${id} right?`)
  }
})

test('a ticket with the person in progress is not counted as running work, so a stopped ticket beside it still reads as stopped', () => {
  const tickets = [hitlTicket('SQ-1', 'doing'), ticketOf('SQ-2', 'Afk left', 'doing')]
  const cards = boardCards(tickets, DEFAULT_BOARD_CONFIG)
  const summary = summarize(tickets, new Set(['SQ-1', 'SQ-2']), NOW)
  const agentOnTheHitlTicket = { model: 'claude-opus-5-5', description: 'SQ-1 Look at SQ-1' }
  const itsRun = { ticket: 'SQ-1', category: 'build', model: 'claude-opus-5-5', effort: 'high', requestedModel: 'opus' }
  const oneAgentOnTheHitlTicket = { ...noActivity, agents: { 'agent-1': agentOnTheHitlTicket }, runs: { 'agent-1': itsRun }, doingTickets: doingTicketsIn(cards) }

  expect(doingTicketsIn(cards)).toEqual(['SQ-2'])
  expect(summary.doing).toBe(1)
  expect(bandLine(summary, oneAgentOnTheHitlTicket, 120).counts).toContain('1 ticket stopped')
})

test('an 80 column band that has to shorten still counts the question from an earlier session', () => {
  const fresh = ticketOf('SQ-1', 'Pick the colour', 'needs-you')
  const earlier = ticketOf('SQ-9', 'Pick the limit', 'needs-you', { updated: '2026-11-21', log: [`${stampAgo(4 * DAY)} moved to needs-you`] })
  const summary = { ...summarize([fresh, earlier], new Set(['SQ-1']), NOW, [planWithOpenDecisions()]), ready: 1 }

  expect(bandLine(summary, noActivity, 120).warnings).toBe('1 ticket needs you, 1 plan needs you, 1 waiting on you from earlier sessions')
  expect(bandLine(summary, noActivity, 80).warnings).toBe('3 need you')
})

test('a decision matches its open question when only the spacing inside it differs', () => {
  const plan = planWithOpenDecisions()
  const written = applyStoryPatch(plan, { decisions: [{ question: 'Which  backoff?', answer: 'Exponential', decidedBy: 'human' }] }, STAMP)
  const withATab = applyStoryPatch(plan, { decisions: [{ question: 'How\tmany tries', answer: 'Five', decidedBy: 'human' }] }, STAMP)

  expect(written.questions.map(open => open.question)).toEqual(['How many tries?'])
  expect(withATab.questions.map(open => open.question)).toEqual(['Which backoff?'])
})

test('the board tool states the rule the waiting view follows, and a checkpoint behind unbuilt work is not said to wait for the person', () => {
  const description = JSON.stringify(SIDEQUEST_TOOLS.find(tool => tool.name === 'board'))
  const checkpoint = { ...hitlTicket('SQ-2', 'ready'), blockedBy: ['SQ-1'] }
  const summaryView = textOfView('summary', filesOf([ticketOf('SQ-1', 'Build the retry', 'doing'), checkpoint]))

  expect(description).toContain('hitl once its turn has come: past the inbox, open, not proposed, every blocker done or in review')
  expect(description).not.toContain('hitl and not done or parked')
  expect(summaryView).not.toContain('waits for the person')
})

test('the could-do line and the closing report leave out a checkpoint whose turn has not come, and take it up once it has', () => {
  const checkpoint = { ...hitlTicket('SQ-2', 'ready'), blockedBy: ['SQ-1'] }
  const behindUnbuiltWork = [ticketOf('SQ-1', 'Build the retry', 'doing'), checkpoint]
  const behindBuiltWork = [ticketOf('SQ-1', 'Build the retry', 'done'), checkpoint]
  const nothingChanged = new Map<string, string | undefined>()
  const nothingInterrupted = new Map<string, string>()

  expect(whatThePersonCouldDo(behindUnbuiltWork, NOW).join('\n')).not.toContain('SQ-2')
  expect(closingReportText(behindUnbuiltWork, nothingChanged, nothingInterrupted)).not.toContain('waiting on you')
  expect(whatThePersonCouldDo(behindBuiltWork, NOW).join('\n')).toContain('SQ-2')
  expect(closingReportText(behindBuiltWork, nothingChanged, nothingInterrupted)).toContain('1 waiting on you')
})

test('the could-do line offers no checkpoint that is built but behind unbuilt work, and none the person already answered', () => {
  const builtBehindUnbuiltWork = [ticketOf('SQ-1', 'Build the retry', 'doing'), { ...hitlTicket('SQ-2', 'review'), blockedBy: ['SQ-1'] }]
  const alreadyAnswered = [ticketOf('SQ-1', 'Build the retry', 'done'), { ...hitlTicket('SQ-2', 'ready'), blockedBy: ['SQ-1'], answerSent: 'A', answerSentAt: STAMP }]
  const aPlainBuiltChange = [ticketOf('SQ-3', 'Built change', 'review')]

  expect(whatThePersonCouldDo(builtBehindUnbuiltWork, NOW).join('\n')).not.toContain('SQ-2')
  expect(whatThePersonCouldDo(alreadyAnswered, NOW).join('\n')).not.toContain('SQ-2')
  expect(whatThePersonCouldDo(aPlainBuiltChange, NOW).join('\n')).toContain('SQ-3')
})

test('a ticket with the person that was left in progress is listed once, with what waits, and not again as stopped', () => {
  const tickets = [hitlTicket('SQ-5', 'doing'), ticketOf('SQ-6', 'Afk left', 'doing')]
  const leftBehind = boardCards(tickets, DEFAULT_BOARD_CONFIG).map(card => ({ ...card, interrupted: 'no run in this session' }))
  const paneText = paneLinesAsText(boardPaneLines({ ...paneFor(leftBehind), touchedHere: new Set(['SQ-5', 'SQ-6']) }))

  expect(paneText.split('\n').filter(row => /^\s*SQ-5\b/.test(row)).length).toBe(1)
  expect(paneText).not.toContain('Look at SQ-5')
  expect(paneText.split('Waits on you')[1]?.split('\n\n')[0]).toContain('Is SQ-5 right?')
  expect(paneText).toContain('SQ-6')
})
