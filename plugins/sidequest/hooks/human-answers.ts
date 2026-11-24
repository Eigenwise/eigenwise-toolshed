import { appendLogLine, applyTicketPatch, oneLine, OTHER_PICK, RECOMMENDED_PICK } from './tickets'
import type { Section, Story, Ticket } from './tickets'
import type { OpenQuestion } from './decisions-for-you'

// `sessionLine` is present only when the human decided something the session is waiting for.
export type HumanWrite = { ticket: Ticket; sessionLine?: string }

const SETTLED_STATUSES = ['done', 'parked', 'dropped']

export const isCheckpoint = (ticket: Ticket): boolean => ticket.mode === 'hitl' && ticket.kind === 'review'

export const waitsOnHuman = (ticket: Ticket): boolean =>
  ticket.status === 'needs-you' || (ticket.mode === 'hitl' && !SETTLED_STATUSES.includes(ticket.status))

// Seen in a real run: the board still said it waited on the person minutes after they sent their answer from it. What
// they sent is with the session from the send on, until the session moves the ticket or asks again.
export const isAnswerWithSession = (ticket: Pick<Ticket, 'answerSent'>): boolean => ticket.answerSent !== undefined

export const awaitsHumanAnswer = (ticket: Ticket): boolean => waitsOnHuman(ticket) && !isAnswerWithSession(ticket)

export const needsHumanAnswer = (ticket: Ticket): boolean => ticket.status === 'needs-you' && !isAnswerWithSession(ticket)

const STATUSES_THAT_ARE_OVER = ['done', 'dropped']

export const canBeApproved = (ticket: Ticket): boolean => isCheckpoint(ticket) && !STATUSES_THAT_ARE_OVER.includes(ticket.status)

// The view a press comes from can be older than the file: a checkpoint the session finished or dropped meanwhile is left as it is.
export const approvedByHuman = (ticket: Ticket, stamp: string): HumanWrite | undefined => {
  if (!canBeApproved(ticket)) return undefined

  return {
    ticket: appendLogLine(applyTicketPatch(ticket, { status: 'done' }, stamp), stamp, 'approved by human in the board'),
    sessionLine: `I approved ${ticket.id} (${ticket.title}) on the board. Carry on with what it was holding up.`,
  }
}

// The view a send comes from can be older than the file: a ticket that waits no more takes the answer on its log only.
const withAnswerSent = (ticket: Ticket, answer: string): Ticket => (waitsOnHuman(ticket) ? { ...ticket, answerSent: answer } : ticket)

export const answeredByHuman = (ticket: Ticket, typed: string, stamp: string): HumanWrite | undefined => {
  const answer = oneLine(typed)
  if (answer === '') return undefined

  return {
    ticket: appendLogLine(withAnswerSent(ticket, answer), stamp, `answered by human in the board: ${answer}`),
    sessionLine: `My answer on ${ticket.id} (${ticket.title}), written on the ticket from the board: ${answer}`,
  }
}

const aboutLine = (id: string, title: string, words: string): string => `About ${id} (${title}), from the board: "${words}"`

// Not an answer to a question: the ticket keeps its status, and the words reach the session as the person's message.
export const saidAboutTicket = (ticket: Ticket, typed: string, stamp: string): HumanWrite | undefined => {
  const words = oneLine(typed)
  if (words === '') return undefined

  return {
    ticket: appendLogLine(ticket, stamp, `said by human in the board: ${words}`),
    sessionLine: aboutLine(ticket.id, ticket.title, words),
  }
}

// While an agent builds the ticket, what the person says goes to that agent, so the line is for it and not the session.
export const saidToItsAgent = (ticket: Ticket, typed: string, stamp: string): HumanWrite | undefined => {
  const words = oneLine(typed)
  if (words === '') return undefined

  return { ticket: appendLogLine(ticket, stamp, `said by human in the board, sent to its running agent: ${words}`) }
}

export const wordsForItsAgent = (ticket: { id: string; title: string }, typed: string): string =>
  `The person, on the board, about ${ticket.id} (${ticket.title}) that you are working on: "${oneLine(typed)}"`

// What the person picked in a waiting ticket's form, sent as one answer: the answer, the extras they ticked, their words.
export type PaneAnswer = { picked: string; alsoDo: readonly string[]; words: string }

export const paneAnswerText = (answer: PaneAnswer): string =>
  [answer.picked, answer.alsoDo.length === 0 ? '' : `Also do: ${answer.alsoDo.join('; ')}`, oneLine(answer.words)].filter(part => part !== '').join('. ')

// Seen in a real run: each decision went out as "not" plus its whole recommended text, about 150 words of which 25
// were the person's. The session has every answer's text, so a switched decision says the other answer in its own
// words and the rest are named by number; the person's words go last, on a line of their own.
export type PlanAnswer = { decisions: string; words: string }

const LONG_OTHER_ANSWER = 80
const FIRST_SENTENCE = /^.*?[.!?](?=\s|$)/

const withoutFinalStop = (text: string): string => text.replace(/[.!?]+$/, '')

const otherAnswerWords = (otherCosts: string): string => {
  const text = oneLine(otherCosts)
  if (text === '') return 'the other answer'

  return withoutFinalStop(text.length > LONG_OTHER_ANSWER ? (FIRST_SENTENCE.exec(text)?.[0] ?? text) : text)
}

const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

const everyOne = (count: number): string => (count === 2 ? 'Both' : `All ${COUNT_WORDS[count] ?? String(count)}`)

const numbersSaid = (numbers: readonly number[]): string =>
  numbers.length === 1 ? String(numbers[0]) : `${numbers.slice(0, -1).join(', ')} and ${String(numbers.at(-1))}`

const recommendedClause = (recommended: readonly number[], count: number): string => {
  if (recommended.length === 0) return ''
  const which = recommended.length === count && count > 1 ? everyOne(count) : numbersSaid(recommended)

  return `${which}: ${recommended.length === 1 ? 'the recommended answer' : 'the recommended answers'}`
}

export const planAnswer = (questions: readonly Pick<OpenQuestion, 'otherCosts'>[], otherAnswers: readonly number[], typed: string): PlanAnswer => {
  const numbers = questions.map((_, index) => index + 1)
  const switched = numbers.filter(number => otherAnswers.includes(number - 1)).map(number => `${number}: ${otherAnswerWords(questions[number - 1]?.otherCosts ?? '')}`)
  const recommended = recommendedClause(numbers.filter(number => !otherAnswers.includes(number - 1)), questions.length)

  return { decisions: [...switched, recommended].filter(part => part !== '').join('; '), words: oneLine(typed) }
}

const IN_MY_WORDS = 'In my words:'

const planAnswerLines = (answer: PlanAnswer): string[] => [`${answer.decisions}.`, answer.words === '' ? '' : `${IN_MY_WORDS} ${answer.words}`]

const planAnswerOnOneLine = (answer: PlanAnswer): string => planAnswerLines(answer).filter(part => part !== '').join(' ')

const planAnswerApart = (answer: PlanAnswer): string => planAnswerLines(answer).filter(part => part !== '').join('\n')

export type StoryRemark ={ story: Story; sessionLine: string }

const STORY_LOG = 'Log'

const withLogLine = (sections: readonly Section[], line: string): Section[] => {
  const log = sections.find(section => section.heading === STORY_LOG)
  const text = [log?.text ?? '', `- ${line}`].filter(part => part !== '').join('\n')

  return [...sections.filter(section => section !== log), { heading: STORY_LOG, text }]
}

// Said while the playback waits for its yes, the words are the person's correction, sent in place of the yes.
const withCorrectionSent = (story: Story, words: string): Story => (story.awaitsYes ? { ...story, playbackAnswerSent: words } : story)

// A story has no log of its own, so what the person said goes under a Log section at its end, kept like any section.
export const saidAboutStory = (story: Story, typed: string, stamp: string): StoryRemark | undefined => {
  const words = oneLine(typed)
  if (words === '') return undefined
  const written = withCorrectionSent(story, words)

  return {
    story: { ...written, otherSections: withLogLine(story.otherSections, `${stamp} said by human in the board: ${words}`), updated: stamp.slice(0, 10) },
    sessionLine: aboutLine(story.id, story.title, words),
  }
}

const proposedCount = (count: number): string => (count === 1 ? 'its proposed ticket' : `its ${count} proposed tickets`)

const wordsBeside = (typed: string): string => (oneLine(typed) === '' ? '' : ` And: "${oneLine(typed)}"`)

// Pressed on the board, the yes is the person's own message: the session publishes on it as on a typed yes.
export const YES_BUILD_IT = 'Yes, build it'

export const saidYesOnThePlan = (story: Story, count: number, typed: string, stamp: string): StoryRemark => ({
  story: { ...story, playbackAnswerSent: `${YES_BUILD_IT}.${wordsBeside(typed)}`, otherSections: withLogLine(story.otherSections, `${stamp} yes, build it, said by human in the board${wordsBeside(typed)}`), updated: stamp.slice(0, 10) },
  sessionLine: `Yes, build it: my yes on ${story.id} (${story.title}) and ${proposedCount(count)}, from the board.${wordsBeside(typed)}`,
})

// Kept on the story as sent, so the plan view draws each pick and the words in place of the form until the session
// records them or asks again.
const withDecisionsSent = (story: Story, otherAnswers: readonly number[], words: string): Story => ({
  ...story,
  decisionPicksSent: story.questions.map((_, index) => (otherAnswers.includes(index) ? OTHER_PICK : RECOMMENDED_PICK)),
  ...(words === '' ? {} : { decisionWordsSent: words }),
})

export const planAnsweredByHuman = (story: Story, otherAnswers: readonly number[], typed: string, stamp: string): StoryRemark => {
  const answer = planAnswer(story.questions, otherAnswers, typed)
  const sent = withDecisionsSent(story, otherAnswers, answer.words)

  return {
    story: { ...sent, otherSections: withLogLine(story.otherSections, `${stamp} answered by human in the board: ${planAnswerOnOneLine(answer)}`), updated: stamp.slice(0, 10) },
    sessionLine: `My answers on ${story.id} (${story.title}), from the board: ${planAnswerApart(answer)}`,
  }
}
