import type { IdsOnBoard } from './board-ids'
import { DECISIONS_FOR_YOU, decisionsForYouSection, openQuestionsFrom } from './decisions-for-you'
import type { OpenQuestion } from './decisions-for-you'
import { EXCERPTS_HEADING, PATH_HEADING, excerptsFrom, excerptsSection, pathFrom, pathSection } from './code-path'
import type { Excerpt, PathStep } from '../types'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import type { Frontmatter, FrontmatterDocument, FrontmatterValue } from './frontmatter'

export const TICKET_STATUSES = ['inbox', 'ready', 'doing', 'review', 'needs-you', 'done', 'parked', 'dropped'] as const
export const TICKET_KINDS = ['build', 'decision', 'research', 'review'] as const
export const TICKET_MODES = ['afk', 'hitl'] as const

export type Section = { heading: string; text: string }

// What reading a hand-edited file found. `isDamaged`: the file was not read and must not be written. `duplicatedKeys`: keys
// written twice (the last value was kept). `hasByteOrderMark`: the file began with one, and a write puts it back.
export type ReadingNotes = Pick<FrontmatterDocument, 'isDamaged' | 'hasByteOrderMark' | 'duplicatedKeys'>

export type Ticket = ReadingNotes & {
  id: string
  title: string
  status: string
  kind: string
  mode: string
  category: string
  story?: string
  branch?: string
  issue?: string
  // The address of its pull request, or only its number when that is all that was given.
  pullRequest?: string
  // `session` when the session opened this work on its own; absent when the person asked for it.
  startedBy?: string
  blockedBy: string[]
  decisions: string[]
  // Names from settings.shared this ticket holds for its whole run. Absent when it uses nothing shared.
  uses?: string[]
  created: string
  updated: string
  what: string
  doneWhen: string
  // The raw `## For you` section, kept as written so a hand-written one survives any write that does not change it.
  forYou: string
  // What the person sent from the board's form while the ticket waited on them. Until the session moves the ticket or
  // writes its For you again, the answer is with the session and the ticket no longer waits on the person.
  answerSent?: string
  // The minute the answer was sent, so the pane can say when. Absent on an answer sent before it was kept.
  answerSentAt?: string
  log: string[]
  otherFields: Frontmatter
  otherSections: Section[]
}

// A patch is spread over the ticket, so a key present as undefined erases that field: builders omit absent keys.
export type TicketPatch = Partial<
  Pick<
    Ticket,
    | 'title'
    | 'status'
    | 'kind'
    | 'mode'
    | 'category'
    | 'story'
    | 'branch'
    | 'issue'
    | 'pullRequest'
    | 'startedBy'
    | 'blockedBy'
    | 'decisions'
    | 'uses'
    | 'what'
    | 'doneWhen'
    | 'forYou'
  >
>

export type Story = ReadingNotes & {
  id: string
  title: string
  created: string
  updated: string
  destination: string
  // The short version of the plan, written once: the plan view leads with it, and the chat gets it where no pane is.
  inShort: string
  decisions: string
  outOfScope: string
  handOver: string
  analysis: string
  path: PathStep[]
  excerpts: Excerpt[]
  questions: OpenQuestion[]
  // Set while the playback waits for the person's yes on the plan and its tickets, so the pane shows that wait.
  awaitsYes?: true
  // What the person sent from the board on the plan's decisions (per decision `recommended` or `other`, and their own
  // words), and on its playback (the yes or a correction). Each holds until the session writes the questions, or the
  // mark, again: until then that part no longer waits on them.
  decisionPicksSent?: string[]
  decisionWordsSent?: string
  decisionDaySent?: string
  playbackAnswerSent?: string
  otherFields: Frontmatter
  otherSections: Section[]
}

export type Decision = { question: string; answer: string; decidedBy: string; decidedOn?: string; words?: string }

// Two short sentences: an answer and its reason, and still one line on a page.
export const DECISION_WORDS_LIMIT = 200

export type StoryPatch = Partial<Pick<Story, 'title' | 'destination' | 'inShort' | 'outOfScope' | 'handOver' | 'analysis' | 'path' | 'excerpts' | 'questions'>> & {
  decisions?: Decision[]
  awaitsYes?: boolean
}

const OPTIONAL_TICKET_FIELDS = ['story', 'branch', 'issue', 'pullRequest', 'startedBy'] as const
const ANSWER_SENT = 'answerSent'
const ANSWER_SENT_AT = 'answerSentAt'
const TICKET_FIELD_NAMES = ['id', 'title', 'status', 'kind', 'mode', 'category', ...OPTIONAL_TICKET_FIELDS, 'blockedBy', 'decisions', 'uses', 'created', 'updated', ANSWER_SENT, ANSWER_SENT_AT]
const AWAITS_YES = 'awaitsYes'
const DECISION_PICKS_SENT = 'decisionPicksSent'
const DECISION_WORDS_SENT = 'decisionWordsSent'
const DECISION_DAY_SENT = 'decisionDaySent'
const PLAYBACK_ANSWER_SENT = 'playbackAnswerSent'
const STORY_FIELD_NAMES = ['id', 'title', 'created', 'updated', AWAITS_YES, DECISION_PICKS_SENT, DECISION_WORDS_SENT, DECISION_DAY_SENT, PLAYBACK_ANSWER_SENT]
export const RECOMMENDED_PICK = 'recommended'
export const OTHER_PICK = 'other'
const TICKET_SECTION_NAMES = ['For you', 'What', 'Done when', 'Log']
export const IN_SHORT = 'In short'
const STORY_SECTION_NAMES = ['Destination', IN_SHORT, 'Analysis', PATH_HEADING, EXCERPTS_HEADING, DECISIONS_FOR_YOU, 'Decisions', 'Out of scope', 'Hand-over']
export const STARTED_BY_SESSION = 'session'

export const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1]) || 0

export const inIdOrder = (tickets: readonly Ticket[]): Ticket[] => [...tickets].sort((left, right) => idNumber(left.id) - idNumber(right.id))

export const minuteStamp = (milliseconds: number): string => `${new Date(milliseconds).toISOString().slice(0, 16)}Z`

const dayOf = (stamp: string): string => stamp.slice(0, 10)

export const spokenMinutes = (minutes: number): string =>
  minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`

export const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()

export const lastStartStamp = (log: readonly string[]): string | undefined =>
  log.flatMap(line => /^(\S+) started /.exec(line)?.[1] ?? []).at(-1)

export const runDuration = (log: readonly string[], stamp: string): string | undefined => {
  const started = lastStartStamp(log)
  const minutes = started === undefined ? Number.NaN : Math.round((Date.parse(stamp) - Date.parse(started)) / 60000)

  return Number.isFinite(minutes) && minutes >= 0 ? spokenMinutes(minutes) : undefined
}

const textField = (fields: Frontmatter, key: string): string => {
  const value = fields[key]

  return Array.isArray(value) ? value.join(', ') : (value ?? '')
}

const listField = (fields: Frontmatter, key: string): string[] => {
  const value = fields[key]
  if (Array.isArray(value)) return value

  return value ? [value] : []
}

const fieldsOutside = (fields: Frontmatter, known: string[]): Frontmatter =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => !known.includes(key)))

export const parseSections = (body: string): Section[] => {
  const sections: Section[] = []
  for (const line of body.split('\n')) {
    const heading = /^## (.+)$/.exec(line)?.[1]
    if (heading !== undefined) sections.push({ heading: heading.trim(), text: '' })
    else appendToLastSection(sections, line)
  }

  return sections.map(section => ({ ...section, text: section.text.trim() }))
}

const appendToLastSection = (sections: Section[], line: string): void => {
  const last = sections[sections.length - 1]
  if (last) last.text += `${line}\n`
}

const sectionText = (sections: Section[], heading: string): string =>
  sections.find(section => section.heading.toLowerCase() === heading.toLowerCase())?.text ?? ''

const sectionsOutside = (sections: Section[], known: string[]): Section[] =>
  sections.filter(section => !known.some(heading => heading.toLowerCase() === section.heading.toLowerCase()))

const joinSections = (sections: Section[]): string =>
  sections.map(section => `## ${section.heading}\n${section.text}`.trimEnd()).join('\n\n')

const logLines = (text: string): string[] =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2))

type OptionalTicketFields = Pick<Ticket, (typeof OPTIONAL_TICKET_FIELDS)[number]>

const optionalTicketFields = (fields: Frontmatter): OptionalTicketFields => {
  const present: OptionalTicketFields = {}
  for (const key of OPTIONAL_TICKET_FIELDS) {
    const value = textField(fields, key)
    if (value !== '') present[key] = value
  }

  return present
}

// An empty optional field is how a patch removes it, so it is never written as an empty value.
export const withoutEmptyOptionalFields = (ticket: Ticket): Ticket => {
  const kept = { ...ticket }
  for (const key of OPTIONAL_TICKET_FIELDS) if (kept[key] === '') delete kept[key]
  if (kept.uses?.length === 0) delete kept.uses

  return kept
}

const answerSentField = (fields: Frontmatter): Pick<Ticket, 'answerSent' | 'answerSentAt'> => {
  const answer = textField(fields, ANSWER_SENT)
  const sentAt = textField(fields, ANSWER_SENT_AT)

  return answer === '' ? {} : { answerSent: answer, ...(sentAt === '' ? {} : { answerSentAt: sentAt }) }
}

// Seen in a real run: a copy that kept no answerSent field logged the answer twice and the ticket kept waiting. Such a
// ticket is read as answered when the last thing on its log is the answer pressed on the board.
const ANSWER_LOG_LINE = /^(\S+) answered by human in the board: (.+)$/s

const answerSentFromLog = (status: string, log: readonly string[]): Pick<Ticket, 'answerSent' | 'answerSentAt'> => {
  if (status !== 'needs-you') return {}
  const [, sentAt = '', answer = ''] = ANSWER_LOG_LINE.exec(log.at(-1) ?? '') ?? []

  return answer === '' ? {} : { answerSent: answer, answerSentAt: sentAt }
}

const answerSentOf = (fields: Frontmatter, status: string, log: readonly string[]): Pick<Ticket, 'answerSent' | 'answerSentAt'> => {
  const written = answerSentField(fields)

  return written.answerSent === undefined ? answerSentFromLog(status, log) : written
}

const usesField = (fields: Frontmatter): Pick<Ticket, 'uses'> => {
  const uses = listField(fields, 'uses')

  return uses.length === 0 ? {} : { uses }
}

const readingNotesOf = (document: FrontmatterDocument): ReadingNotes => {
  const { isDamaged, hasByteOrderMark, duplicatedKeys } = document

  return {
    ...(isDamaged === undefined ? {} : { isDamaged }),
    ...(hasByteOrderMark === undefined ? {} : { hasByteOrderMark }),
    ...(duplicatedKeys === undefined ? {} : { duplicatedKeys }),
  }
}

// A file with no closing fence reads as empty, so writing it would replace what the person wrote with blanks.
const refuseDamaged = (notes: ReadingNotes, name: string): void => {
  if (notes.isDamaged) throw new Error(`${name}: the frontmatter has no closing --- line, so the file is not written`)
}

export const parseTicket = (text: string, fallbackId = ''): Ticket => {
  const document = parseFrontmatter(text)
  const { fields, body } = document
  const sections = parseSections(body)
  const log = logLines(sectionText(sections, 'Log'))

  return {
    ...readingNotesOf(document),
    id: textField(fields, 'id') || fallbackId,
    title: textField(fields, 'title'),
    status: textField(fields, 'status'),
    kind: textField(fields, 'kind'),
    mode: textField(fields, 'mode'),
    category: textField(fields, 'category'),
    ...optionalTicketFields(fields),
    blockedBy: listField(fields, 'blockedBy'),
    decisions: listField(fields, 'decisions'),
    ...usesField(fields),
    created: textField(fields, 'created'),
    updated: textField(fields, 'updated'),
    what: sectionText(sections, 'What'),
    doneWhen: sectionText(sections, 'Done when'),
    forYou: sectionText(sections, 'For you'),
    ...answerSentOf(fields, textField(fields, 'status'), log),
    log,
    otherFields: fieldsOutside(fields, TICKET_FIELD_NAMES),
    otherSections: sectionsOutside(sections, TICKET_SECTION_NAMES),
  }
}

export const serializeTicket = (ticket: Ticket): string => {
  refuseDamaged(ticket, ticket.id)
  const fields: Record<string, FrontmatterValue | undefined> = {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    kind: ticket.kind,
    mode: ticket.mode,
    category: ticket.category,
    story: ticket.story,
    branch: ticket.branch,
    issue: ticket.issue,
    pullRequest: ticket.pullRequest,
    startedBy: ticket.startedBy,
    blockedBy: ticket.blockedBy,
    decisions: ticket.decisions,
    uses: ticket.uses,
    created: ticket.created,
    updated: ticket.updated,
    answerSent: ticket.answerSent,
    answerSentAt: ticket.answerSent === undefined ? undefined : ticket.answerSentAt,
  }
  const sections = [
    ...forYouSection(ticket.forYou),
    { heading: 'What', text: textInsideSection('What', ticket.what) },
    { heading: 'Done when', text: textInsideSection('Done when', ticket.doneWhen) },
    { heading: 'Log', text: ticket.log.map(line => `- ${line}`).join('\n') },
    ...ticket.otherSections,
  ]

  return serializeFrontmatter({ ...definedFields(fields), ...ticket.otherFields }, `\n${joinSections(sections)}\n`, ticket.hasByteOrderMark === true)
}

const forYouSection = (text: string): Section[] => (text === '' ? [] : [{ heading: 'For you', text: textInsideSection('For you', text) }])

const definedFields = (fields: Record<string, FrontmatterValue | undefined>): Frontmatter => {
  const defined: Frontmatter = {}
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) defined[key] = value

  return defined
}

export const newTicket = (id: string, patch: TicketPatch, stamp: string): Ticket => ({
  id,
  title: '',
  status: 'ready',
  kind: 'build',
  mode: 'afk',
  category: 'build',
  blockedBy: [],
  decisions: [],
  created: dayOf(stamp),
  updated: dayOf(stamp),
  what: '',
  doneWhen: '',
  forYou: '',
  log: [],
  otherFields: {},
  otherSections: [],
  ...patch,
})

export const withoutSentAnswer = (ticket: Ticket): Ticket => {
  const kept = { ...ticket }
  delete kept.answerSent
  delete kept.answerSentAt

  return kept
}

// Moving the ticket, or writing its For you again, is the session taking up what the person sent or asking anew.
const takesUpSentAnswer = (patch: TicketPatch): boolean => patch.status !== undefined || patch.forYou !== undefined

export const applyTicketPatch = (ticket: Ticket, patch: TicketPatch, stamp: string): Ticket => ({
  ...(takesUpSentAnswer(patch) ? withoutSentAnswer(ticket) : ticket),
  ...patch,
  updated: dayOf(stamp),
})

export const withChangedTickets = (tickets: readonly Ticket[], changed: readonly Ticket[]): Ticket[] => {
  const changedIds = new Set(changed.map(ticket => ticket.id))

  return [...tickets.filter(ticket => !changedIds.has(ticket.id)), ...changed]
}

export const appendLogLine = (ticket: Ticket, stamp: string, line: string): Ticket => ({
  ...ticket,
  log: [...ticket.log, `${stamp} ${line}`],
  updated: dayOf(stamp),
})

type TicketCheck = { isBroken: (ticket: Ticket, ids: IdsOnBoard) => boolean; problem: (ticket: Ticket, ids: IdsOnBoard) => string }

const isOneOf = (value: string, allowed: readonly string[]): boolean => allowed.includes(value)

const TICKET_CHECKS: TicketCheck[] = [
  { isBroken: (ticket, ids) => !ids.isTicketId(ticket.id), problem: (ticket, ids) => `id "${ticket.id}" is not like ${ids.ticketExample}` },
  { isBroken: ticket => ticket.title.trim() === '', problem: () => 'title is empty' },
  {
    isBroken: ticket => !isOneOf(ticket.status, TICKET_STATUSES),
    problem: ticket => `status "${ticket.status}" is not one of ${TICKET_STATUSES.join(', ')}`,
  },
  {
    isBroken: ticket => !isOneOf(ticket.kind, TICKET_KINDS),
    problem: ticket => `kind "${ticket.kind}" is not one of ${TICKET_KINDS.join(', ')}`,
  },
  {
    isBroken: ticket => !isOneOf(ticket.mode, TICKET_MODES),
    problem: ticket => `mode "${ticket.mode}" is not one of ${TICKET_MODES.join(', ')}`,
  },
  {
    isBroken: (ticket, ids) => ticket.story !== undefined && !ids.isStoryId(ticket.story),
    problem: (ticket, ids) => `story "${ticket.story}" is not like ${ids.storyExample}`,
  },
  {
    isBroken: ticket => ticket.startedBy !== undefined && ticket.startedBy !== STARTED_BY_SESSION,
    problem: ticket => `startedBy "${ticket.startedBy}" is not ${STARTED_BY_SESSION}: leave it out when the person asked for the work`,
  },
  {
    isBroken: (ticket, ids) => !ticket.blockedBy.every(ids.isTicketId),
    problem: ticket => `blockedBy [${ticket.blockedBy.join(', ')}] holds something that is not a ticket id`,
  },
]

// A category is not checked here: one with no route is written anyway, and start runs it on the default category.
export const validateTicket = (ticket: Ticket, ids: IdsOnBoard): string[] =>
  TICKET_CHECKS.filter(check => check.isBroken(ticket, ids)).map(check => `${ticket.id}: ${check.problem(ticket, ids)}`)

const awaitsYesOf = (awaitsYes: boolean | undefined): Pick<Story, 'awaitsYes'> => (awaitsYes ? { awaitsYes: true } : {})

type DecisionsSent = Pick<Story, 'decisionPicksSent' | 'decisionWordsSent' | 'decisionDaySent'>
type SentFromTheBoard = DecisionsSent & Pick<Story, 'playbackAnswerSent'>

const decisionsSentIn = (fields: Frontmatter): DecisionsSent => {
  const picks = listField(fields, DECISION_PICKS_SENT)
  if (picks.length === 0) return {}

  const words = textField(fields, DECISION_WORDS_SENT)
  const day = textField(fields, DECISION_DAY_SENT)

  return {
    decisionPicksSent: picks,
    ...(words === '' ? {} : { decisionWordsSent: words }),
    ...(day === '' ? {} : { decisionDaySent: day }),
  }
}

const sentFromTheBoard = (fields: Frontmatter): SentFromTheBoard => {
  const playbackAnswer = textField(fields, PLAYBACK_ANSWER_SENT)

  return { ...decisionsSentIn(fields), ...(playbackAnswer === '' ? {} : { playbackAnswerSent: playbackAnswer }) }
}

const sentFromTheBoardFields = (story: Story): Frontmatter =>
  definedFields({
    [DECISION_PICKS_SENT]: story.decisionPicksSent,
    [DECISION_WORDS_SENT]: story.decisionWordsSent,
    [DECISION_DAY_SENT]: story.decisionDaySent,
    [PLAYBACK_ANSWER_SENT]: story.playbackAnswerSent,
  })

export const parseStory = (text: string, fallbackId = ''): Story => {
  const document = parseFrontmatter(text)
  const { fields, body } = document
  const sections = parseSections(body)

  return {
    ...readingNotesOf(document),
    id: textField(fields, 'id') || fallbackId,
    title: textField(fields, 'title'),
    created: textField(fields, 'created'),
    updated: textField(fields, 'updated'),
    destination: sectionText(sections, 'Destination'),
    inShort: sectionText(sections, IN_SHORT),
    decisions: sectionText(sections, 'Decisions'),
    outOfScope: sectionText(sections, 'Out of scope'),
    handOver: sectionText(sections, 'Hand-over'),
    analysis: sectionText(sections, 'Analysis'),
    path: pathFrom(sectionText(sections, PATH_HEADING)),
    excerpts: excerptsFrom(sectionText(sections, EXCERPTS_HEADING)),
    questions: openQuestionsFrom(sectionText(sections, DECISIONS_FOR_YOU)),
    ...awaitsYesOf(textField(fields, AWAITS_YES) === 'true'),
    ...sentFromTheBoard(fields),
    otherFields: fieldsOutside(fields, STORY_FIELD_NAMES),
    otherSections: sectionsOutside(sections, STORY_SECTION_NAMES),
  }
}

export const serializeStory = (story: Story): string => {
  refuseDamaged(story, story.id)
  const fields: Frontmatter = {
    id: story.id,
    title: story.title,
    created: story.created,
    updated: story.updated,
    ...(story.awaitsYes ? { [AWAITS_YES]: 'true' } : {}),
    ...sentFromTheBoardFields(story),
  }
  const sections = [
    { heading: 'Destination', text: story.destination },
    ...sectionWhenWritten(IN_SHORT, story.inShort),
    ...sectionWhenWritten('Analysis', story.analysis),
    ...sectionWhenWritten(PATH_HEADING, pathSection(story.path)),
    ...sectionWhenWritten(EXCERPTS_HEADING, excerptsSection(story.excerpts)),
    ...sectionWhenWritten(DECISIONS_FOR_YOU, decisionsForYouSection(story.questions)),
    { heading: 'Decisions', text: story.decisions },
    { heading: 'Out of scope', text: story.outOfScope },
    ...sectionWhenWritten('Hand-over', story.handOver),
    ...story.otherSections,
  ]

  return serializeFrontmatter({ ...fields, ...story.otherFields }, `\n${joinSections(sections)}\n`, story.hasByteOrderMark === true)
}

const decisionCount = (decisionsText: string): number => decisionsText.split('\n').filter(line => /^- D-\d+/.test(line.trim())).length

// What a person sees as one character can be several code points: a flag is two, a joined emoji up to seven, an
// accented letter two. A cut that counts code points kept half a flag and dropped an accent.
const charactersAsSeen = (text: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), piece => piece.segment)

export const wordsKept = (typed: string): string =>
  charactersAsSeen(oneLine(typed.replace(/\r/g, '\n')))
    .slice(0, DECISION_WORDS_LIMIT)
    .join('')

const decidedOnPart = (day: string | undefined): string => (day === undefined ? '' : ` on ${day}`)

// A default is no one's words, so only a decision the person took keeps them.
const theirWordsPart = (decision: Decision): string => {
  const words = decision.decidedBy === 'human' ? wordsKept(decision.words ?? '') : ''

  return words === '' ? '' : `. Their words: "${words}"`
}

const decisionLine = (decision: Decision, number: number, day: string): string =>
  `- D-${number}: ${decision.question} Answer: ${decision.answer} Decided by: ${decision.decidedBy}${decidedOnPart(decision.decidedOn ?? day)}${theirWordsPart(decision)}`

export const withDecisions = (decisionsText: string, decisions: readonly Decision[], day: string): string => {
  const first = decisionCount(decisionsText) + 1
  const lines = decisions.map((decision, index) => decisionLine(decision, first + index, day))

  return [decisionsText, ...lines].filter(line => line !== '').join('\n')
}

const DECISION_LINE_START = /^- D-\d+: /
// The first status that runs to the end of the line, so a person's words that quote one stay words.
const DECISION_STATUS = / Decided by: (human|default)(?: on (\d{4}-\d{2}-\d{2}))?(?:\. Their words: "([\s\S]*)")?$/
const ANSWER_MARK = ' Answer: '

const questionAndAnswer = (text: string): Pick<Decision, 'question' | 'answer'> => {
  const markAt = text.indexOf(ANSWER_MARK)

  return markAt < 0 ? { question: text, answer: '' } : { question: text.slice(0, markAt), answer: text.slice(markAt + ANSWER_MARK.length) }
}

const withoutMissing = (fields: Pick<Decision, 'decidedOn' | 'words'>): Pick<Decision, 'decidedOn' | 'words'> =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

const decisionRead = (line: string): Decision[] => {
  const text = line.trim()
  const start = DECISION_LINE_START.exec(text)
  const status = DECISION_STATUS.exec(text)
  if (start === null || status === null) return []
  const [, decidedBy = '', decidedOn, words] = status

  return [{ ...questionAndAnswer(text.slice(start[0].length, status.index)), decidedBy, ...withoutMissing({ decidedOn, words }) }]
}

// A line with no day reads with no day and no words. A retired decision has no answer and reads with an empty one.
export const decisionsRead = (decisionsText: string): Decision[] => decisionsText.split('\n').flatMap(decisionRead)

export const newStory = (id: string, title: string, stamp: string): Story => ({
  id,
  title,
  created: dayOf(stamp),
  updated: dayOf(stamp),
  destination: '',
  inShort: '',
  decisions: '',
  outOfScope: '',
  handOver: '',
  analysis: '',
  path: [],
  excerpts: [],
  questions: [],
  otherFields: {},
  otherSections: [],
})

const ownHeading = (heading: string): RegExp => new RegExp(`^\\s*## ${heading}[ \\t]*\\r?\\n?`)

// A line that starts with two hashes opens a new section of a ticket or story file, so what followed it in a field
// was read back as another section and gone after the next write (seen in a ticket's what, whose approach then never
// reached the brief). Its own heading is taken off, any other goes one level down.
const textInsideSection = (heading: string, text: string): string => text.replace(ownHeading(heading), '').replace(/^## /gm, '### ')

const sectionWhenWritten = (heading: string, text: string): Section[] =>
  text === '' ? [] : [{ heading, text: textInsideSection(heading, text) }]

// Writing the questions again records what the person sent or asks anew, and so does writing the mark for the yes.
const decisionsSentKept = (sent: DecisionsSent, patch: StoryPatch): DecisionsSent => (patch.questions === undefined ? presentDecisionsSent(sent) : {})

const presentDecisionsSent = (sent: DecisionsSent): DecisionsSent => ({
  ...(sent.decisionPicksSent === undefined ? {} : { decisionPicksSent: sent.decisionPicksSent }),
  ...(sent.decisionWordsSent === undefined ? {} : { decisionWordsSent: sent.decisionWordsSent }),
  ...(sent.decisionDaySent === undefined ? {} : { decisionDaySent: sent.decisionDaySent }),
})

const playbackAnswerKept = (sent: string | undefined, patch: StoryPatch): SentFromTheBoard =>
  sent === undefined || patch.awaitsYes !== undefined ? {} : { playbackAnswerSent: sent }

export const withoutPlaybackAnswer = (story: Story): Story => {
  const kept = { ...story }
  delete kept.playbackAnswerSent

  return kept
}

export const applyStoryPatch = (story: Story, patch: StoryPatch, stamp: string): Story => {
  const { decisions, awaitsYes, ...replacements } = patch
  const { awaitsYes: awaitedBefore, decisionPicksSent, decisionWordsSent, decisionDaySent, playbackAnswerSent, ...rest } = story

  return {
    ...rest,
    ...awaitsYesOf(awaitsYes ?? awaitedBefore),
    ...decisionsSentKept({ decisionPicksSent, decisionWordsSent, decisionDaySent }, patch),
    ...playbackAnswerKept(playbackAnswerSent, patch),
    ...replacements,
    decisions: withDecisions(story.decisions, decisions ?? [], dayOf(stamp)),
    updated: dayOf(stamp),
  }
}
