// One made-up task, PAY-41, followed from the first message to the pull request on the board. Each step is taken with
// the plugin's own ticket tool, run tools and the functions the pane's buttons call, and the board is saved after it
// as a named state: a scratch project of its own, in the plugin's file formats, read back by the plugin's own reader.
// The merge itself happens on the code host, which the board does not draw.
import { DEFAULT_BOARD_CONFIG, serializeBoardConfig } from '../../plugins/sidequest/hooks/board-config.ts'
import { answeredByHuman, paneAnswerText, planAnsweredByHuman, saidYesOnThePlan } from '../../plugins/sidequest/hooks/human-answers.ts'
import { proposedTicketsOf } from '../../plugins/sidequest/hooks/proposed-tickets.ts'
import { NO_PROVIDERS } from '../../plugins/sidequest/hooks/routing.ts'
import { finishTicket, startTicket } from '../../plugins/sidequest/hooks/run-tools.ts'
import { readBoard } from '../../plugins/sidequest/hooks/store.ts'
import type { BoardFiles } from '../../plugins/sidequest/hooks/store.ts'
import { applyTicketOperations } from '../../plugins/sidequest/hooks/ticket-tool.ts'
import type { SessionTurn } from '../../plugins/sidequest/hooks/ticket-tool.ts'
import { serializeStory, serializeTicket } from '../../plugins/sidequest/hooks/tickets.ts'
import type { Story, Ticket } from '../../plugins/sidequest/hooks/tickets.ts'
import { afterAMainTurnStarts, askedIn, finishedAgentOf, withFinishedAgent } from '../../plugins/sidequest/hooks/views/finished-agents.ts'
import type { FinishedAgent, LiveAgents, SidequestRun } from '../../plugins/sidequest/types/index.d.ts'

import * as madeUp from './made-up.mts'
import { engineOverDisk, writeText } from './scratch-project.mts'

// In the order they happen. A later page can draw any of them.
export const STORY_STATES = [
  'planned',
  'decisions-answered',
  'before-the-yes',
  'building',
  'agents-finished',
  'being-checked',
  'commit-question',
  'answered',
  'done',
] as const

export type StoryState = (typeof STORY_STATES)[number]

export type ChatEntry = { saidByThePerson: string } | ToolCall
export type ToolCall = { tool: string; input: Record<string, unknown>; output?: string; run?: SidequestRun }

export type BoardMoment = {
  state: StoryState
  projectFolder: string
  files: BoardFiles
  now: number
  agents: LiveAgents
  runs: Record<string, SidequestRun>
  finishedAgents: readonly FinishedAgent[]
  // What the chat shows since the person last spoke.
  chat: readonly ChatEntry[]
}

// One turn of the session: what woke it, at what minute, and the agents it started. The usage page is drawn from these.
export type StoryTurn = { at: number; words: string; spawned: { agentId: string; model: string; run: SidequestRun }[] }

// An agent's run ends at the minute it returns, on the model it ran on.
export type AgentReturn = { agentId: string; model: string; at: number }

export type PlayedStory = { moments: Map<StoryState, BoardMoment>; turns: readonly StoryTurn[]; agentReturns: readonly AgentReturn[]; endsAt: number }

const MINUTE = 60_000

type Session = Omit<BoardMoment, 'state' | 'projectFolder' | 'chat'> & { chat: ChatEntry[]; turns: StoryTurn[]; agentReturns: AgentReturn[] }

type Change = { tickets: Ticket[]; stories: Story[]; config?: BoardFiles['config'] }
type ToolResult = { answer: { text?: string; refusal?: string }; change?: Change }

const byId = <Item extends { id: string }>(first: Item, second: Item): number => first.id.localeCompare(second.id, undefined, { numeric: true })

const merged = <Item extends { id: string }>(old: readonly Item[], changed: readonly Item[]): Item[] =>
  [...old.filter(one => !changed.some(other => other.id === one.id)), ...changed].sort(byId)

const withChange = (session: Session, change: Change): void => {
  const files = session.files
  session.files = { ...files, tickets: merged(files.tickets, change.tickets), stories: merged(files.stories, change.stories), config: change.config ?? files.config }
}

const stampOf = (clock: number): string => new Date(clock).toISOString().slice(0, 16) + 'Z'

const nextStamp = (session: Session): string => {
  session.now += MINUTE
  return stampOf(session.now)
}

const applied = (session: Session, result: ToolResult): string => {
  if (result.answer.text === undefined) throw new Error(`the plugin refused a made-up step: ${result.answer.refusal}`)
  if (result.change) withChange(session, result.change)

  return result.answer.text
}

// A finished agent stays under Now for the main turns right after it returns, as the pane's hook counts them.
const turnStarts = (session: Session, words: string): void => {
  session.finishedAgents = afterAMainTurnStarts(session.finishedAgents)
  session.turns.push({ at: session.now, words, spawned: [] })
}

const personSays = (session: Session, words: string): void => {
  session.chat = [{ saidByThePerson: words }]
  turnStarts(session, words)
}

const turnOf = (words: string): SessionTurn => ({ words: { source: 'person', words }, ticketsThisSessionCreated: new Set<string>() })

const PREFIX_FACTS = { folderName: madeUp.SIDEQUEST_PROJECT, trackerKeys: [madeUp.TRACKER_KEY] }

const writeOnTheBoard = (session: Session, operations: Record<string, unknown>[], words = ''): void => {
  const input = { operations }
  const output = applied(session, applyTicketOperations(input, session.files, nextStamp(session), turnOf(words), new Set(), PREFIX_FACTS))
  session.chat.push({ tool: 'mcp__sidequest__ticket', input, output })
}

const theStory = (session: Session): Story => {
  const story = session.files.stories[0]
  if (story === undefined) throw new Error('the made-up plan was not filed')
  return story
}

const ticketNumber = (session: Session, index: number): Ticket => {
  const title = madeUp.PLAN_TICKETS[index]?.title
  const ticket = session.files.tickets.find(one => one.title === title)
  if (ticket === undefined) throw new Error(`no made-up ticket ${index + 1}`)
  return ticket
}

const agentNumber = (index: number): (typeof madeUp.AGENTS)[number] => {
  const agent = madeUp.AGENTS[index]
  if (agent === undefined) throw new Error(`no made-up agent for ticket ${index + 1}`)
  return agent
}

const ticketOperation = (ticket: { title: string; what: string; doneWhen: string }, story: string) => ({
  op: 'create',
  ...ticket,
  status: 'ready',
  kind: 'build',
  mode: 'afk',
  category: 'build',
  issue: madeUp.PIECE_OF_WORK,
  branch: madeUp.WORK_BRANCH,
  story,
})

const fileThePlan = (session: Session): void => {
  personSays(session, madeUp.PERSON_ASKS)
  writeOnTheBoard(
    session,
    [{ op: 'story', title: `${madeUp.PIECE_OF_WORK} Upload retry`, destination: '', inShort: madeUp.IN_SHORT, analysis: madeUp.ANALYSIS, path: madeUp.CODE_PATH, questions: madeUp.PLAN_QUESTIONS }],
    madeUp.PERSON_ASKS,
  )
}

// What the plan's Send writes, as the pane's press would; its session line is the person's one message.
const answerTheDecisions = (session: Session): void => {
  const sent = planAnsweredByHuman(theStory(session), madeUp.OTHER_ANSWERS_PICKED, madeUp.PERSONS_OWN_WORDS, nextStamp(session))
  withChange(session, { tickets: [], stories: [sent.story] })
  personSays(session, sent.sessionLine)
}

const playBackThePlan = (session: Session): void => {
  const story = theStory(session).id
  writeOnTheBoard(session, [
    { op: 'patch', id: story, destination: madeUp.DESTINATION, outOfScope: madeUp.OUT_OF_SCOPE, decisions: madeUp.PLAN_DECISIONS, questions: [], awaitsYes: true },
    ...madeUp.PLAN_TICKETS.map(ticket => ticketOperation(ticket, story)),
  ])
  writeOnTheBoard(session, [{ op: 'patch', id: ticketNumber(session, 2).id, blockedBy: [ticketNumber(session, 1).id] }])
}

// A string field of the JSON Agent call inside the start answer, read back with its escapes undone.
const jsonField = (text: string, field: string): string | undefined => {
  const quoted = new RegExp(`"${field}": ("(?:[^"\\\\]|\\\\.)*")`).exec(text)?.[1]
  const value: unknown = quoted === undefined ? undefined : JSON.parse(quoted)

  return typeof value === 'string' ? value : undefined
}

// The start answer carries the Agent call the session makes next.
const agentCallOf = (ticket: Ticket, startAnswer: string) => ({
  subagent_type: jsonField(startAnswer, 'subagent_type') ?? 'sidequest:worker',
  description: `${ticket.id} ${ticket.title}`,
  prompt: jsonField(startAnswer, 'prompt') ?? `[route:${ticket.category}] ${ticket.id} ${ticket.title}`,
})

const routeOf = (ticket: Ticket, startAnswer: string, model: string): SidequestRun => ({
  ticket: ticket.id,
  category: ticket.category,
  model,
  effort: jsonField(startAnswer, 'effort') ?? '',
  requestedModel: model,
})

// The spawn hook records the route of the agent the call starts, as here.
const startWithAgent = (session: Session, index: number): void => {
  const ticket = ticketNumber(session, index)
  const agent = agentNumber(index)
  const input = { id: ticket.id }
  const output = applied(session, startTicket(input, session.files, NO_PROVIDERS, nextStamp(session), {}))
  session.chat.push({ tool: 'mcp__sidequest__start', input, output })
  const run = routeOf(ticket, output, jsonField(output, 'model') ?? agent.model)
  const call = agentCallOf(ticket, output)
  session.chat.push({ tool: 'Agent', input: call, run })
  session.agents[agent.agentId] = { model: agent.model, description: call.description, asked: askedIn(call.prompt) }
  session.runs[agent.agentId] = run
  session.turns.at(-1)?.spawned.push({ agentId: agent.agentId, model: agent.model, run })
}

const sayYesAndStart = (session: Session): void => {
  const story = theStory(session)
  const yes = saidYesOnThePlan(story, proposedTicketsOf(story, session.files.tickets).length, '', nextStamp(session))
  withChange(session, { tickets: [], stories: [yes.story] })
  personSays(session, yes.sessionLine)
  writeOnTheBoard(session, [{ op: 'patch', id: story.id, awaitsYes: false }], yes.sessionLine)
  startWithAgent(session, 0)
  startWithAgent(session, 1)
}

// An agent's return wakes the session for a turn of its own, with no words of the person's, and that turn records it.
const agentComesBack = (session: Session, index: number): void => {
  const agent = agentNumber(index)
  const live = session.agents[agent.agentId]
  if (live === undefined) throw new Error(`made-up agent ${index + 1} is not running`)
  session.now += agent.minutes * MINUTE
  const end = { agentId: agent.agentId, durationMs: agent.minutes * MINUTE, answer: agent.report }
  session.finishedAgents = withFinishedAgent(session.finishedAgents, finishedAgentOf(end, live, session.runs[agent.agentId]))
  delete session.agents[agent.agentId]
  session.agentReturns.push({ agentId: agent.agentId, model: agent.model, at: session.now })
  turnStarts(session, '')
  const input = { id: ticketNumber(session, index).id, outcome: 'done', checked: madeUp.CHECKED, result: agent.report }
  const output = applied(session, finishTicket(input, session.files, nextStamp(session)))
  session.chat.push({ tool: 'mcp__sidequest__finish', input, output })
}

const firstTwoComeBack = (session: Session): void => {
  session.chat = []
  agentComesBack(session, 0)
  agentComesBack(session, 1)
}

// The third is started in the turn the second one's return woke.
const lastOneIsBuiltAndChecked = (session: Session): void => {
  startWithAgent(session, 2)
  agentComesBack(session, 2)
  writeOnTheBoard(session, [{ op: 'patch', id: ticketNumber(session, 2).id, forYou: { sayingYesTo: madeUp.WHAT_CHANGED } }])
}

const reviewPassesAndAsks = (session: Session): void => {
  writeOnTheBoard(session, [0, 1, 2].map(index => ({ op: 'note', id: ticketNumber(session, index).id, text: madeUp.REVIEW_NOTE })))
  writeOnTheBoard(session, [{ op: 'patch', id: ticketNumber(session, 2).id, status: 'needs-you', forYou: madeUp.COMMIT_QUESTION }])
}

// The person's pick, sent from the ticket's form.
const personAnswers = (session: Session): void => {
  const last = ticketNumber(session, 2)
  const answer = answeredByHuman(last, paneAnswerText({ picked: madeUp.PERSON_PICKS, alsoDo: [], words: '' }), nextStamp(session))
  if (answer === undefined) throw new Error('the made-up commit question took no answer')
  withChange(session, { tickets: [answer.ticket], stories: [] })
  personSays(session, answer.sessionLine ?? madeUp.PERSON_PICKS)
}

// The session commits, pushes and opens the pull request, then records it on the three tickets.
const pullRequestRecorded = (session: Session): void => {
  const ids = [0, 1, 2].map(index => ticketNumber(session, index).id)
  session.now += madeUp.MINUTES_TO_OPEN_THE_PULL_REQUEST * MINUTE
  writeOnTheBoard(session, [
    ...ids.map(id => ({ op: 'patch', id, pullRequest: madeUp.PULL_REQUEST })),
    ...ids.map(id => ({ op: 'move', id, status: 'done' })),
  ])
}

const STEP_INTO: Record<StoryState, (session: Session) => void> = {
  planned: fileThePlan,
  'decisions-answered': answerTheDecisions,
  'before-the-yes': playBackThePlan,
  building: sayYesAndStart,
  'agents-finished': firstTwoComeBack,
  'being-checked': lastOneIsBuiltAndChecked,
  'commit-question': reviewPassesAndAsks,
  answered: personAnswers,
  done: pullRequestRecorded,
}

async function savedAndReadBack(session: Session, projectFolder: string): Promise<BoardFiles> {
  const folder = `${projectFolder}/.sidequest`
  writeText(`${folder}/board.json`, serializeBoardConfig(session.files.config))
  for (const ticket of session.files.tickets) writeText(`${folder}/tickets/${ticket.id}.md`, serializeTicket(ticket))
  for (const story of session.files.stories) writeText(`${folder}/stories/${story.id}.md`, serializeStory(story))
  const read = await readBoard(engineOverDisk, { root: projectFolder })

  return { ...read, checkedOutBranch: madeUp.WORK_BRANCH }
}

const momentOf = async (session: Session, state: StoryState, scratchFolder: string): Promise<BoardMoment> => {
  const projectFolder = `${scratchFolder}/${state}/${madeUp.SIDEQUEST_PROJECT}`

  return {
    state,
    projectFolder,
    files: await savedAndReadBack(session, projectFolder),
    now: session.now,
    agents: { ...session.agents },
    runs: { ...session.runs },
    finishedAgents: [...session.finishedAgents],
    chat: [...session.chat],
  }
}

/** Plays the whole story once and keeps the board as it stood at each named state, each in its own scratch project. */
export async function playTheStory(scratchFolder: string): Promise<PlayedStory> {
  const files: BoardFiles = { config: DEFAULT_BOARD_CONFIG, configText: undefined, tickets: [], stories: [], checkedOutBranch: madeUp.WORK_BRANCH }
  const session: Session = { files, now: madeUp.FIRST_MINUTE, agents: {}, runs: {}, finishedAgents: [], chat: [], turns: [], agentReturns: [] }
  const moments = new Map<StoryState, BoardMoment>()
  for (const state of STORY_STATES) {
    STEP_INTO[state](session)
    moments.set(state, await momentOf(session, state, scratchFolder))
  }

  return { moments, turns: session.turns, agentReturns: session.agentReturns, endsAt: session.now }
}
