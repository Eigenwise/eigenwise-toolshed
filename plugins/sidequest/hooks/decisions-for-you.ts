import type { DecisionForYou } from '../types'

// `recommended` holds one part per line: an answer with several parts is a short list.
export type OpenQuestion = { question: string; recommended: string; otherCosts: string }

export const DECISIONS_FOR_YOU = 'Decisions for you'

const RECOMMENDED = 'Recommended:'
const OTHERWISE = 'Otherwise:'
const OTHER_COSTS = 'The other answer costs:'
const LIST_ITEM = '- '
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

const countWord = (count: number): string => NUMBER_WORDS[count] ?? String(count)

export const recommendedParts = (question: OpenQuestion): string[] =>
  question.recommended
    .split('\n')
    .map(part => part.trim())
    .filter(part => part !== '')

// Seen in real runs: every part came back in backticks, prose too (`default "exclude" (today's behaviour)`, a one-line
// `Leave it out of PAY-41.`). Which part reads as code cannot be told from its characters, so the session marks it.
const recommendedLines = (question: OpenQuestion): string[] => {
  const parts = recommendedParts(question)
  if (parts.length <= 1) return [`${RECOMMENDED} ${parts[0] ?? ''}`]

  return [RECOMMENDED, ...parts.map(part => `${LIST_ITEM}${part}`)]
}

const otherwiseLine = (question: OpenQuestion): string => (question.otherCosts === '' ? '' : `${OTHERWISE} ${question.otherCosts}`)

export const decisionForYou = (question: OpenQuestion, index: number): DecisionForYou => ({
  question: `${index + 1}. ${question.question}`,
  recommended: recommendedLines(question),
  otherwise: otherwiseLine(question),
})

export const decisionsForYouLines = (questions: readonly OpenQuestion[]): DecisionForYou[] => questions.map(decisionForYou)

// Seen in a real run: a question with its answer on one line read as a dense paragraph. In the chat each part is a list
// line of its own, so no renderer joins them.
const chatLinesOf = (decision: DecisionForYou): string[] => [
  decision.question,
  ...decision.recommended.map((line, index) => (index === 0 ? `   ${LIST_ITEM}${line}` : `     ${line}`)),
  ...(decision.otherwise === '' ? [] : [`   ${LIST_ITEM}${decision.otherwise}`]),
]

const headingFor = (count: number): string => `${countWord(count)} ${count === 1 ? 'decision' : 'decisions'} for you`

const whatYesTakes = (count: number): string => {
  if (count === 1) return 'yes takes the recommended answer'
  if (count === 2) return 'yes takes both recommended answers'

  return `yes takes all ${countWord(count).toLowerCase()} recommended answers`
}

export const chatBlockOf = (questions: readonly OpenQuestion[]): string =>
  [
    headingFor(questions.length),
    '',
    ...decisionsForYouLines(questions).flatMap(chatLinesOf),
    '',
    `Answer by number, or ${whatYesTakes(questions.length)}. The reasoning for each is in the plan on the board (/board opens it).`,
  ].join('\n')

const fileRecommendedLines = (question: OpenQuestion): string[] => {
  const parts = recommendedParts(question)
  if (parts.length <= 1) return [`   ${RECOMMENDED} ${parts[0] ?? ''}`]

  return [`   ${RECOMMENDED}`, ...parts.map(part => `   ${LIST_ITEM}${part}`)]
}

const fileEntryOf = (question: OpenQuestion, index: number): string[] => [
  `${index + 1}. ${question.question}`,
  ...fileRecommendedLines(question),
  ...(question.otherCosts === '' ? [] : [`   ${OTHER_COSTS} ${question.otherCosts}`]),
]

export const decisionsForYouSection = (questions: readonly OpenQuestion[]): string => questions.flatMap(fileEntryOf).join('\n')

const afterLabel = (line: string, label: string): string | undefined => (line.startsWith(label) ? line.slice(label.length).trim() : undefined)

const withPart = (recommended: string, part: string): string => (recommended === '' ? part : `${recommended}\n${part}`)

const fillIn = (question: OpenQuestion, line: string): void => {
  if (line.startsWith(LIST_ITEM)) question.recommended = withPart(question.recommended, line.slice(LIST_ITEM.length).trim())
  question.recommended = afterLabel(line, RECOMMENDED) ?? question.recommended
  question.otherCosts = afterLabel(line, OTHER_COSTS) ?? question.otherCosts
}

const readLine = (questions: OpenQuestion[], line: string): void => {
  const opened = /^\d+\.\s+(.*)$/.exec(line)?.[1]
  const current = questions.at(-1)
  if (opened !== undefined) questions.push({ question: opened.trim(), recommended: '', otherCosts: '' })
  else if (current !== undefined) fillIn(current, line)
}

export const openQuestionsFrom = (sectionText: string): OpenQuestion[] => {
  const questions: OpenQuestion[] = []
  for (const line of sectionText.split('\n')) readLine(questions, line.trim())

  return questions
}

const OTHER_COSTS_ASK = 'patch questions with what the other answer is and what it costs, so the person sees what turning it down means.'

// Seen in a real run: no decision said what the other answer costs, so the person saw only one side of each.
export const missingOtherCostsLine = (questions: readonly OpenQuestion[]): string => {
  const numbers = questions.flatMap((question, index) => (question.otherCosts === '' ? [index + 1] : []))
  if (numbers.length === 0) return ''

  return numbers.length === 1
    ? `Question ${numbers[0]} has no otherCosts (written anyway): ${OTHER_COSTS_ASK}`
    : `Questions ${numbers.join(', ')} have no otherCosts (written anyway): ${OTHER_COSTS_ASK}`
}
