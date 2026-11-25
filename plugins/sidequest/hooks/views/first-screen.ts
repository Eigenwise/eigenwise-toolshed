import { reviewStandingLine } from '../review-standing'
import { SAYING_YES_TO_PARTS } from '../saying-yes-to'
import type { SayingYesTo } from '../saying-yes-to'
import type { Ticket } from '../tickets'

// What leads a view on its first screen: a pane shows about 45 rows and scrolling it is a three-key chord, so the
// control the person came for sits there and the long read follows.

const DECISION_START = /^- D-\d+\b/
const DECIDED_BY_DEFAULT = /\s*Decided by: default(?: on \d{4}-\d{2}-\d{2})?\s*$/
const DECIDED_BY_STATUS = /\bDecided by: (human|default)\b/

const statusAsDrawn = (line: string): string =>
  line.replace(DECIDED_BY_STATUS, (_, decidedBy: string) => (decidedBy === 'human' ? 'Decided by: you' : 'Taken by default'))

// The story file keeps `human` and `default`; the board speaks to that person. Only the first status of a line is
// one: a later one sits in the person's own words, which are shown as they said them.
export const decisionsAsDrawn = (decisionsText: string): string => decisionsText.split('\n').map(statusAsDrawn).join('\n')

const PARAGRAPH_BREAK = /\n\s*\n/

// A session may write the proof and where it ends into the destination too; only what is true when done leads.
export const destinationLead = (destination: string): string => destination.trim().split(PARAGRAPH_BREAK)[0] ?? ''

export const destinationRest = (destination: string): string => destination.trim().split(PARAGRAPH_BREAK).slice(1).join('\n\n')

const decisionEntries = (decisionsText: string): string[] =>
  decisionsText.split('\n').reduce<string[]>((entries, line) => {
    if (DECISION_START.test(line.trim()) || entries.length === 0) return [...entries, line]

    return [...entries.slice(0, -1), `${entries.at(-1) ?? ''}\n${line}`]
  }, [])

const isTakenByDefault = (entry: string): boolean => DECIDED_BY_DEFAULT.test(entry)

const ANSWER_START = /\bAnswer:\s*/
const UNDO_AND_AFTER = /\s*\bUndo:.*$/

const ENTRY_START = /^- D-\d+:\s*/

const entryOnOneLine = (entry: string): string => entry.replace(DECIDED_BY_DEFAULT, '').replace(/\s*\n\s*/g, ' ').trim()

const answerOf = (oneLineEntry: string): string => {
  const answerAt = ANSWER_START.exec(oneLineEntry)
  const answer = answerAt === null ? oneLineEntry.replace(ENTRY_START, '') : oneLineEntry.slice(answerAt.index + answerAt[0].length)

  return answer.replace(UNDO_AND_AFTER, '').trim()
}

const questionOf = (oneLineEntry: string): string => {
  const answerAt = ANSWER_START.exec(oneLineEntry)

  return answerAt === null ? '' : oneLineEntry.slice(0, answerAt.index).replace(ENTRY_START, '').trim()
}

const SHORT_QUESTION = 40
const CLAUSE_END = /[?,;:(]/

const wordsWithin = (text: string, width: number): string => (text.length <= width ? text : text.slice(0, width + 1).replace(/\s+\S*$/, ''))

// The question cut to its first clause or about 40 characters, whichever is shorter, so the answer beside it fits.
export const shortQuestion = (question: string): string => {
  const clause = question.split(CLAUSE_END)[0]?.trim() ?? ''

  return clause === '' ? '' : `${wordsWithin(clause, SHORT_QUESTION - 1).replace(/[\s.!]+$/, '')}?`
}

const takenByDefaultRow = (entry: string): string => {
  const oneLineEntry = entryOnOneLine(entry)

  return [shortQuestion(questionOf(oneLineEntry)), answerOf(oneLineEntry)].filter(part => part !== '').join(' ')
}

// What the yes accepts unseen: each decision the session took by default, its question in short and its answer, the
// rest drawn after the yes. Seen on a real plan: the answer alone read "No." with nothing to say what it overruled.
export const takenByDefaultRows = (decisionsText: string): string[] => decisionEntries(decisionsText).filter(isTakenByDefault).map(takenByDefaultRow)

// No size from the hunks: they are a chosen part of the diff, and on a real board their count contradicted the
// session's own figures right below it.
const branchLine = (ticket: Ticket): string => (ticket.branch === undefined ? '' : `On branch ${ticket.branch}.`)

const LONGEST_SUMMARY = 3

const firstLinesOfWhatIsSaidYesTo = (parts: SayingYesTo): string[] => {
  const first = SAYING_YES_TO_PARTS.map(part => parts[part]).find(text => text.trim() !== '') ?? ''

  return first.split('\n').filter(line => line.trim() !== '')
}

// Two or three lines from what the ticket carries; where it carries too little, the start of what is said yes to.
export const commitSummaryLines = (ticket: Ticket, parts: SayingYesTo): string[] => {
  const carried = [reviewStandingLine(ticket), branchLine(ticket)].filter(line => line !== '')
  const filled = carried.length >= 2 ? carried : [...carried, ...firstLinesOfWhatIsSaidYesTo(parts)]

  return filled.slice(0, LONGEST_SUMMARY)
}
