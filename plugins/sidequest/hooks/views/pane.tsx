import type { Color, Elements, RenderElement, RenderPropsOf } from 'claude-code'

import type { DecisionForYou, FinishedAgentDetail, PlanForm, ProposedTicket, SayingYesToShown, SidequestSummary, StoryDetail, TicketDetail, TicketForm } from '../../types'
import { DECISIONS_FOR_YOU } from '../decisions-for-you'
import { YES_BUILD_IT } from '../human-answers'
import { pressWords, ticketPresses, widgetCounts } from './board-view'
import { ASIDE_GAP, cutToColumns, fittedRow, readingScrollCue, storyScrollCue, withScrollCue } from './pane-sections'
import type { PaneLine, RowPress, ScrollWindow, SectionRow, SectionTone } from './pane-sections'
import { CHANGED_STEP, excerptsDrawing, pathDrawing } from './code-path-drawing'

type BoardElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown' | 'Input' | 'Code'>

export type BoardPaneState = {
  props: RenderPropsOf['Pane']
  summary: SidequestSummary
  lines: readonly PaneLine[]
  setAside: readonly PaneLine[] | null
  older: readonly PaneLine[] | null
  detail: TicketDetail | null
  story: StoryDetail | null
  finishedAgent: FinishedAgentDetail | null
  moreFinished: readonly PaneLine[] | null
  forms: { ticket: TicketForm; plan: PlanForm }
}

export type BoardPaneActions = {
  openTicket: (id: string) => Promise<void>
  openStory: (id: string) => Promise<void>
  openStoryDecisions: (id: string) => Promise<void>
  closeStory: () => Promise<void>
  pickAnswer: (id: string, label: string) => Promise<void>
  tickAlsoYours: (id: string, index: number) => Promise<void>
  showWholeTicket: (id: string) => Promise<void>
  typeTicketWords: (id: string, typed: string) => Promise<void>
  sendTicketAnswer: (id: string) => Promise<void>
  keepTicketWords: (id: string, typed: string) => Promise<void>
  keepPlanWords: (id: string, typed: string) => Promise<void>
  sendTicketRemark: (id: string) => Promise<void>
  sendStoryRemark: (id: string) => Promise<void>
  togglePlanAnswer: (id: string, index: number) => Promise<void>
  typePlanWords: (id: string, typed: string) => Promise<void>
  sendPlanAnswers: (id: string) => Promise<void>
  sayYesToPlan: (id: string) => Promise<void>
  approveCheckpoint: (id: string) => Promise<void>
  viewAgent: (agentId: string) => Promise<void>
  closeTicket: () => Promise<void>
  showSetAside: () => Promise<void>
  closeSetAside: () => Promise<void>
  showOlder: () => Promise<void>
  closeOlder: () => Promise<void>
  setAsideTicket: (id: string) => Promise<void>
  dropTicket: (id: string) => Promise<void>
  tidyWorktrees: () => Promise<void>
  openFinishedAgent: (agentId: string) => Promise<void>
  closeFinishedAgent: () => Promise<void>
  showMoreFinished: () => Promise<void>
  closeMoreFinished: () => Promise<void>
}

type Drawing = { elements: BoardElements; actions: BoardPaneActions; columns: number }

const NO_ANALYSIS_WORDS = 'Nothing was written up for this plan yet.'
const NO_REPORT_WORDS = 'It handed back no text.'
const NO_TRANSCRIPT_WORDS = 'The full transcript is no longer available.'
const NO_QUESTION_WORDS = 'This ticket waits on you, but no question was written for it. Ask the session what it needs, or type what you decide.'
const ANSWER_PLACEHOLDER = 'What you decide, in your own words. Send writes it on the ticket and tells the session.'
const SAID_ABOUT_A_TICKET = 'Same as typing in the chat, with this ticket named.'
const SAID_ABOUT_THE_PLAN = 'Same as typing in the chat, with this plan named.'
const WORDS_WITH_THE_DECISIONS = 'Your own words, if any'
const PLAN_SEND_WORDS = 'Send puts your picks and your words in the chat as your one message, and on the plan. Or answer in the chat by number.'
const ALSO_YOURS_WORDS = 'Also yours, tick what to do too'
const ONE_SEND_WORDS = 'Send puts your pick, what you ticked and your words in the chat as your one message, and on the ticket.'
const STILL_REVIEWED_WORDS = 'The review still runs. What it finds, the words that go out and the question come here.'
const SAYING_YES_TO_HEADING = 'What you are saying yes to'
const PROPOSED_TICKETS = 'Proposed tickets'
const TAKEN_BY_DEFAULT = 'Taken by default'
const FULL_TEXT_BELOW = 'The full text of each is below.'
const YES_WORDS = 'Yes, build it puts your yes in the chat as your message, and on the plan. A correction goes in the field and out with Send the correction. Or answer in the chat.'
const CORRECTION_LABEL = 'A correction, if any'
const WITH_THE_SESSION = 'It is with the session now: it records it, or asks again here.'
// What Enter does in every field on the board, drawn beside it while it has focus: Enter never sends, Send does.
const ENTER_KEEPS = 'keep'

const sentWords = (sent: string): string => `You sent: ${sent}`

const sentAtWords = (sent: string, sentAt: string): string => (sentAt === '' ? sentWords(sent) : `${sentWords(sent)} (${sentAt.replace('T', ' ').replace('Z', ' UTC')})`)

const yourWords = (words: string): string => (words === '' ? '' : `Your words: ${words}`)

// The plan view's decisions, which a press on what waits on the person scrolls to.
export const DECISIONS_KEY = 'decisions-for-you'

// One idea carries the pane: each section hangs its rows off a rail in the colour of its state.
const RAIL = '┃ '
const TONE_COLORS: Record<SectionTone, Color> = { live: 'claude', waiting: 'warning', plain: 'text', dim: 'inactive' }
const VIEW_BUTTON_WIDTH = '[ View ]'.length + 1

const rowRoom = (drawing: Drawing, row: SectionRow): number =>
  drawing.columns - RAIL.length - (row.press.opens === 'agent' ? VIEW_BUTTON_WIDTH : 0)

const rowWords = (drawing: Drawing, row: SectionRow): RenderElement => {
  const { Text } = drawing.elements
  const fitted = fittedRow(row, rowRoom(drawing, row))

  return (
    <Text dimColor={row.tone === 'dim'} wrap="truncate-end">
      {fitted.text}
      {fitted.aside !== '' && <Text dimColor>{`${ASIDE_GAP}${fitted.aside}`}</Text>}
    </Text>
  )
}

type WordsPress = { key: string; onPress: () => Promise<void> }

type PressOfOne = Extract<RowPress, { id: string }>

// The yes on a plan opens the same plan as its row under The plan, yet both are drawn at once and the host refuses
// two Buttons of one key, so each carries its own.
const pressesOfOne: Partial<Record<PressOfOne['opens'], (drawing: Drawing, id: string) => WordsPress>> = {
  ticket: (drawing, id) => ({ key: id, onPress: () => drawing.actions.openTicket(id) }),
  'finished-agent': (drawing, id) => ({ key: `finished-${id}`, onPress: () => drawing.actions.openFinishedAgent(id) }),
  story: (drawing, id) => ({ key: `story-${id}`, onPress: () => drawing.actions.openStory(id) }),
  'story-yes': (drawing, id) => ({ key: `yes-${id}`, onPress: () => drawing.actions.openStory(id) }),
  'story-decisions': (drawing, id) => ({ key: `decisions-${id}`, onPress: () => drawing.actions.openStoryDecisions(id) }),
}

// A running agent's press is its View button beside the words, so its words press nothing.
const wordsPressOf = (drawing: Drawing, press: RowPress): WordsPress | undefined => {
  if (press.opens === 'finished-agents') return { key: 'more-finished', onPress: drawing.actions.showMoreFinished }

  return 'id' in press ? pressesOfOne[press.opens]?.(drawing, press.id) : undefined
}

const pressableWords = (drawing: Drawing, row: SectionRow): RenderElement => {
  const { Button } = drawing.elements
  const press = wordsPressOf(drawing, row.press)
  if (press === undefined) return rowWords(drawing, row)

  return (
    <Button key={press.key} plain onPress={press.onPress}>
      {rowWords(drawing, row)}
    </Button>
  )
}

const viewButton = (drawing: Drawing, row: SectionRow): RenderElement | false => {
  const { Button } = drawing.elements
  const press = row.press

  return press.opens === 'agent' && <Button key={`view-${press.id}`} label="View" onPress={() => drawing.actions.viewAgent(press.id)} />
}

const sectionRow = (drawing: Drawing, row: SectionRow, key: string): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        <Text color={TONE_COLORS[row.tone]}>{RAIL}</Text>
        {pressableWords(drawing, row)}
      </Box>
      {viewButton(drawing, row)}
    </Box>
  )
}

type TextLine = Extract<PaneLine, { kind: 'gap' | 'sentence' | 'label' | 'heading' | 'scroll-cue' }>

type HeadingLine = Extract<PaneLine, { kind: 'heading' }>

const headingLine = (drawing: Drawing, line: HeadingLine, key: string): RenderElement => {
  const { Button, Text } = drawing.elements
  const words = (
    <Text key={key} bold wrap="truncate-end">
      {line.text}
    </Text>
  )
  const press = line.press
  if (press?.opens !== 'story') return words

  return (
    <Button key={`story-${press.id}`} plain onPress={() => drawing.actions.openStory(press.id)}>
      {words}
    </Button>
  )
}

const textLine = (drawing: Drawing, line: TextLine, key: string): RenderElement => {
  const { Text } = drawing.elements
  if (line.kind === 'gap') return <Text key={key}> </Text>
  if (line.kind === 'heading') return headingLine(drawing, line, key)
  if (line.kind === 'label') {
    return (
      <Text key={key} bold color={TONE_COLORS[line.tone]}>
        {line.text.toUpperCase()}
      </Text>
    )
  }

  return (
    <Text key={key} dimColor={line.kind === 'scroll-cue' || line.isDim} wrap="truncate-end">
      {line.text}
    </Text>
  )
}

const listButton = (drawing: Drawing, text: string, key: string, onPress: () => Promise<void>): RenderElement => {
  const { Button, Text } = drawing.elements

  return (
    <Button key={key} plain onPress={onPress}>
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    </Button>
  )
}

type OlderTicketLine = Extract<PaneLine, { kind: 'older-ticket' }>

// Both presses take the same path as the ticket tool and are logged as the person's.
const olderTicketRow = (drawing: Drawing, line: OlderTicketLine, key: string): RenderElement => {
  const { Box, Button, Text } = drawing.elements

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        <Text color={TONE_COLORS.dim}>{RAIL}</Text>
        <Button key={line.id} plain onPress={() => drawing.actions.openTicket(line.id)}>
          <Text dimColor wrap="truncate-end">{`${line.text}${ASIDE_GAP}${line.aside}`}</Text>
        </Button>
      </Box>
      <Button key={`set-aside-${line.id}`} label="Set aside" onPress={() => drawing.actions.setAsideTicket(line.id)} />
      <Button key={`drop-${line.id}`} label="Drop" onPress={() => drawing.actions.dropTicket(line.id)} />
    </Box>
  )
}

const worktreeRow = (drawing: Drawing, text: string, key: string): RenderElement => {
  const { Box, Button, Text } = drawing.elements

  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
      <Button key="tidy-worktrees" label="Tidy" onPress={drawing.actions.tidyWorktrees} />
    </Box>
  )
}

const TEXT_LINE_KINDS: readonly string[] = ['gap', 'sentence', 'label', 'heading', 'scroll-cue']

const isTextLine = (line: PaneLine): line is TextLine => TEXT_LINE_KINDS.includes(line.kind)

type ListLine = Extract<PaneLine, { kind: 'set-aside' | 'older' | 'older-ticket' }>

const listLine = (drawing: Drawing, line: ListLine, key: string): RenderElement => {
  if (line.kind === 'older-ticket') return olderTicketRow(drawing, line, key)

  return line.kind === 'older'
    ? listButton(drawing, line.text, 'older', drawing.actions.showOlder)
    : listButton(drawing, line.text, 'set-aside', drawing.actions.showSetAside)
}

const paneLine = (drawing: Drawing, line: PaneLine, index: number): RenderElement => {
  const key = `line-${index}`
  if (line.kind === 'row') return sectionRow(drawing, line, key)
  if (line.kind === 'worktrees') return worktreeRow(drawing, line.text, key)
  if (isTextLine(line)) return textLine(drawing, line, key)

  return listLine(drawing, line, key)
}

const scrollWindowOf = (props: RenderPropsOf['Pane']): ScrollWindow => ({ offset: props.scroll.offset, bodyRows: props.scroll.bodyRows, isFocused: props.isFocused })

const linesView = (drawing: Drawing, lines: readonly PaneLine[], props: RenderPropsOf['Pane']): RenderElement => {
  const { Box } = drawing.elements

  return <Box flexDirection="column">{withScrollCue(lines, scrollWindowOf(props)).map((line, index) => paneLine(drawing, line, index))}</Box>
}

type ListShown = { lines: readonly PaneLine[]; backKey: string; onBack: () => Promise<void> }

const listView = (drawing: Drawing, list: ListShown, props: RenderPropsOf['Pane']): RenderElement => {
  const { Box, Button } = drawing.elements

  return (
    <Box flexDirection="column" gap={1}>
      <Button key={list.backKey} label="Back" onPress={list.onBack} />
      {linesView(drawing, list.lines, props)}
    </Box>
  )
}

const picked = (isPicked: boolean, label: string): string => `${isPicked ? '●' : '○'} ${label}`

const answerButtons = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement => {
  const { Box, Button } = drawing.elements

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {detail.options.map(option => (
        <Button key={option.key} label={picked(form.picked === option.label, option.label)} onPress={() => drawing.actions.pickAnswer(detail.id, option.label)} />
      ))}
    </Box>
  )
}

const ticked = (isTicked: boolean, what: string): string => `[${isTicked ? 'x' : ' '}] ${what}`

const alsoYoursList = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement | false => {
  const { Box, Button, Text } = drawing.elements

  return (
    detail.alsoYours.length > 0 && (
      <Box flexDirection="column">
        <Text bold>{ALSO_YOURS_WORDS}</Text>
        {detail.alsoYours.map((what, index) => (
          <Button key={`also-${index}`} label={ticked(form.ticked.includes(index), what)} onPress={() => drawing.actions.tickAlsoYours(detail.id, index)} />
        ))}
      </Box>
    )
  )
}

const ticketButtons = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box, Button, Text } = drawing.elements
  const presses = ticketPresses(detail)
  const words = pressWords(presses, detail.dropWords)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {presses.canApprove && <Button key="approve" label="Approve" onPress={() => drawing.actions.approveCheckpoint(detail.id)} />}
        {presses.canSetAside && <Button key="set-aside" label="Set aside" onPress={() => drawing.actions.setAsideTicket(detail.id)} />}
        {presses.canDrop && <Button key="drop" label="Drop" onPress={() => drawing.actions.dropTicket(detail.id)} />}
        <Button key="back" label="Back" onPress={drawing.actions.closeTicket} />
      </Box>
      {words !== '' && <Text dimColor>{words}</Text>}
    </Box>
  )
}

type SayField = {
  key: string
  sendKey: string
  label: string
  whereWordsGo: string
  typed: string
  remarkSent: string
  onInput: (typed: string) => Promise<void>
  onKeep: (typed: string) => Promise<void>
  onSend: () => Promise<void>
}

// A half-typed remark reaches the session as surely as a half-typed answer, so here too Enter keeps and Send sends.
const sayField = (drawing: Drawing, field: SayField): RenderElement => {
  const { Box, Button, Input, Text } = drawing.elements

  return (
    <Box key={`${field.key}-field`} flexDirection="column">
      <Input
        key={field.key}
        label={field.label}
        value={field.typed}
        submitLabel={ENTER_KEEPS}
        onInput={typed => void field.onInput(typed)}
        onSubmit={typed => void field.onKeep(typed)}
      />
      <Button key={field.sendKey} label="Send" onPress={field.onSend} />
      <Text dimColor>{field.remarkSent === '' ? field.whereWordsGo : field.remarkSent}</Text>
    </Box>
  )
}

// One field per ticket: one that waits on the person answers it, any other takes what they want to say about it.
// In an answer's field Enter only keeps the words: observed in a real run, Enter sent a half-typed answer, the session
// acted on it and the form came back blank. Send is the one way out, in all three forms.
const answerField = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement => {
  const { Input } = drawing.elements
  if (!detail.takesAnswer) {
    return sayField(drawing, {
      key: 'say',
      sendKey: 'send-remark',
      label: 'Say something about this ticket',
      whereWordsGo: SAID_ABOUT_A_TICKET,
      typed: form.id === detail.id ? form.typed : '',
      remarkSent: form.id === detail.id ? form.remarkSent : '',
      onInput: typed => drawing.actions.typeTicketWords(detail.id, typed),
      onKeep: typed => drawing.actions.keepTicketWords(detail.id, typed),
      onSend: () => drawing.actions.sendTicketRemark(detail.id),
    })
  }

  return (
    <Input
      key="answer"
      label="Anything else"
      placeholder={ANSWER_PLACEHOLDER}
      value={form.id === detail.id ? form.typed : ''}
      submitLabel={ENTER_KEEPS}
      onInput={typed => void drawing.actions.typeTicketWords(detail.id, typed)}
      onSubmit={typed => void drawing.actions.keepTicketWords(detail.id, typed)}
    />
  )
}

const sendButton = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Button } = drawing.elements

  return <Button key="send-answer" label="Send" onPress={() => drawing.actions.sendTicketAnswer(detail.id)} />
}

const sendRow = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box, Button, Text } = drawing.elements

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {sendButton(drawing, detail)}
        <Button key="show-whole" label="Show the whole ticket" onPress={() => drawing.actions.showWholeTicket(detail.id)} />
        <Button key="back" label="Back" onPress={drawing.actions.closeTicket} />
      </Box>
      <Text dimColor>{ONE_SEND_WORDS}</Text>
    </Box>
  )
}

const diffOf = (drawing: Drawing, detail: TicketDetail): RenderElement | false => {
  const { Code } = drawing.elements

  return detail.diff !== '' && <Code key="for-you-diff" source={detail.diff} format="diff" />
}

type YesToPartElements = Pick<BoardElements, 'Code' | 'Markdown' | 'Text'>

const DRAWINGS_OF_A_PART: Record<SayingYesToShown['drawnAs'], (elements: YesToPartElements, part: SayingYesToShown) => RenderElement> = {
  markdown: ({ Markdown }, part) => <Markdown key={`${part.key}-text`} text={part.text} />,
  diff: ({ Code }, part) => <Code key={`${part.key}-text`} source={part.text} format="diff" />,
  words: ({ Text }, part) => <Text key={`${part.key}-text`}>{part.text}</Text>,
}

const yesToPartOf = (drawing: Drawing, part: SayingYesToShown): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box key={part.key} flexDirection="column">
      <Text bold>{part.heading}</Text>
      {DRAWINGS_OF_A_PART[part.drawnAs](drawing.elements, part)}
    </Box>
  )
}

const sayingYesToOf = (drawing: Drawing, detail: TicketDetail, heading = ''): RenderElement | false => {
  const { Box, Text } = drawing.elements

  return (
    detail.sayingYesTo.length > 0 && (
      <Box key="saying-yes-to" flexDirection="column" gap={1}>
        {heading !== '' && <Text bold>{heading}</Text>}
        {detail.sayingYesTo.map(part => yesToPartOf(drawing, part))}
        {detail.isStillReviewed && <Text dimColor>{STILL_REVIEWED_WORDS}</Text>}
      </Box>
    )
  )
}

const commitSummaryOf = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box key="commit-summary" flexDirection="column">
      {detail.summary.map((line, index) => (
        <Text key={`commit-summary-${index}`}>{line}</Text>
      ))}
    </Box>
  )
}

const titleAndFacts = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box flexDirection="column">
      <Text bold>{detail.title}</Text>
      <Text dimColor>{detail.facts}</Text>
    </Box>
  )
}

// Seen in a real run: below the answer sat Set aside, Drop and the whole ticket, the answer scrolled away and its
// decisions read as the ones asked for. The person opened it to answer, so it opens as the question and nothing else.
const wholeTicket = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box, Markdown } = drawing.elements

  return (
    <Box key="whole-ticket" flexDirection="column" gap={1}>
      {ticketButtons(drawing, detail)}
      {titleAndFacts(drawing, detail)}
      <Markdown text={detail.body} />
    </Box>
  )
}

// Seen in a real run: the question and Send came after the changes, the checks, 43 lines of diff, the review and the
// words that go out. Once the review is back there is something to answer, so a short summary and the answer lead;
// while it runs, what is said yes to leads.
const questionView = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement => {
  const { Box, Text } = drawing.elements
  const answerLeads = detail.summary.length > 0

  return (
    <Box flexDirection="column" gap={1}>
      {answerLeads ? commitSummaryOf(drawing, detail) : sayingYesToOf(drawing, detail)}
      <Text bold color="warning">{detail.question}</Text>
      <Box flexDirection="column">
        {detail.forYouLines.map((line, index) => (
          <Text key={`for-you-${index}`}>{line}</Text>
        ))}
      </Box>
      {diffOf(drawing, detail)}
      {answerButtons(drawing, detail, form)}
      {alsoYoursList(drawing, detail, form)}
      {answerField(drawing, detail, form)}
      {sendRow(drawing, detail)}
      {form.showsWhole && wholeTicket(drawing, detail)}
      {answerLeads && sayingYesToOf(drawing, detail, SAYING_YES_TO_HEADING)}
    </Box>
  )
}

const noQuestionLine = (drawing: Drawing, detail: TicketDetail): RenderElement | false => {
  const { Text } = drawing.elements

  return detail.takesAnswer && <Text color="warning">{NO_QUESTION_WORDS}</Text>
}

// Drawn in place of the form that sent it, so what was sent stays readable and there is no Send to press twice.
const sentLines = (drawing: Drawing, key: string, firstLine: string): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box key={key} flexDirection="column">
      {firstLine !== '' && <Text color="claude">{firstLine}</Text>}
      <Text dimColor>{WITH_THE_SESSION}</Text>
    </Box>
  )
}

const questionOf = (drawing: Drawing, detail: TicketDetail): RenderElement | false => {
  const { Text } = drawing.elements

  return detail.question !== '' && <Text bold>{detail.question}</Text>
}

const STATUSES_THAT_ARE_OVER = ['done', 'dropped']

// Seen in the desktop app on a released board: a ticket the board called done still showed a field and Send, and one
// that had asked a question showed it again as open. A ticket that is over is a record of what happened.
const isOver = (detail: TicketDetail): boolean => STATUSES_THAT_ARE_OVER.includes(detail.status)

const ticketHead = (drawing: Drawing, detail: TicketDetail): RenderElement => {
  const { Box } = drawing.elements

  return (
    <Box key="ticket-head" flexDirection="column" gap={1}>
      {titleAndFacts(drawing, detail)}
      {!isOver(detail) && questionOf(drawing, detail)}
      {detail.answerSent !== '' && sentLines(drawing, 'answer-sent', sentAtWords(detail.answerSent, detail.answerSentAt))}
      {sayingYesToOf(drawing, detail)}
      {noQuestionLine(drawing, detail)}
      {diffOf(drawing, detail)}
    </Box>
  )
}

const fieldAndSend = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement | false => {
  const { Box } = drawing.elements

  return (
    !isOver(detail) && (
      <Box key="ticket-field" flexDirection="column" gap={1}>
        {answerField(drawing, detail, form)}
        {detail.takesAnswer && sendButton(drawing, detail)}
      </Box>
    )
  )
}

// Seen in the desktop app on a released board: a ticket with a question drew its field and its buttons above the What
// that explains the question. Where there is a question, what explains it comes before anything to press.
const ticketView = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement => {
  const { Box, Markdown } = drawing.elements
  const explanationLeads = detail.question !== '' && !isOver(detail)
  const body = <Markdown key="ticket-body" text={detail.body} />
  const fieldAndButtons = [fieldAndSend(drawing, detail, form), <Box key="ticket-buttons">{ticketButtons(drawing, detail)}</Box>]

  return (
    <Box flexDirection="column" gap={1}>
      {ticketHead(drawing, detail)}
      {explanationLeads ? [body, ...fieldAndButtons] : [...fieldAndButtons, body]}
    </Box>
  )
}

// The question view is the form a person answers in. A ticket that carries a question it no longer waits on (answered
// and taken up, set aside, finished) is read, not answered: seen in a review, such a ticket still opened as the form.
const detailView = (drawing: Drawing, detail: TicketDetail, form: TicketForm): RenderElement =>
  detail.takesAnswer && detail.question !== '' ? questionView(drawing, detail, form) : ticketView(drawing, detail, form)

const analysisOf = (drawing: Drawing, story: StoryDetail): RenderElement => {
  const { Markdown, Text } = drawing.elements

  return story.analysis === '' ? <Text key="analysis" dimColor>{NO_ANALYSIS_WORDS}</Text> : <Markdown key="analysis" text={story.analysis} />
}

const answerChoice = (takesOther: boolean): string => `${picked(!takesOther, 'recommended')}  ${picked(takesOther, 'the other answer')}`

type PlanDecision = { story: StoryDetail; form: PlanForm; decision: DecisionForYou; index: number }

const isDecisionsSent = (story: StoryDetail): boolean => story.decisionPicksSent.length > 0

const SENT_PICK_WORDS: Record<string, string> = { recommended: 'Your answer: the recommended one', other: 'Your answer: the other one' }

const answerOfDecision = (drawing: Drawing, { story, form, index }: PlanDecision): RenderElement => {
  const { Button, Text } = drawing.elements
  const sentPick = story.decisionPicksSent[index]
  if (sentPick !== undefined) return <Text key={`decision-${index}-sent`} color="claude">{SENT_PICK_WORDS[sentPick] ?? sentPick}</Text>

  return <Button key={`decision-${index}-answer`} label={answerChoice(form.otherAnswers.includes(index))} onPress={() => drawing.actions.togglePlanAnswer(story.id, index)} />
}

// A part like `retries: 2` is code, and a Text would show its backticks, so each line is drawn as markdown.
const decisionOf = (drawing: Drawing, planDecision: PlanDecision): RenderElement => {
  const { Box, Markdown } = drawing.elements
  const { decision, index } = planDecision

  return (
    <Box key={`decision-${index}`} flexDirection="column">
      <Markdown key={`decision-${index}-question`} text={decision.question} />
      {decision.recommended.map((line, lineIndex) => (
        <Markdown key={`decision-${index}-recommended-${lineIndex}`} text={line} />
      ))}
      {decision.otherwise !== '' && <Markdown key={`decision-${index}-otherwise`} text={decision.otherwise} dimColor />}
      {answerOfDecision(drawing, planDecision)}
    </Box>
  )
}

// The chat holds the same numbered lines; this form is the easy way to write that one answer, sent as the person's message.
// Real answers are rarely a bare pick, so the words field sits with the picks rather than under the whole plan.
const decisionsForm = (drawing: Drawing, story: StoryDetail, form: PlanForm): RenderElement => {
  const { Box, Button, Input, Text } = drawing.elements

  return (
    <Box key="decisions-form" flexDirection="column" gap={1}>
      <Input
        key="decisions-words"
        label={WORDS_WITH_THE_DECISIONS}
        value={form.id === story.id ? form.typed : ''}
        submitLabel={ENTER_KEEPS}
        onInput={typed => void drawing.actions.typePlanWords(story.id, typed)}
        onSubmit={typed => void drawing.actions.keepPlanWords(story.id, typed)}
      />
      <Box flexDirection="column">
        <Button key="send-decisions" label="Send" onPress={() => drawing.actions.sendPlanAnswers(story.id)} />
        <Text dimColor>{PLAN_SEND_WORDS}</Text>
      </Box>
    </Box>
  )
}

const decisionsForYouOf = (drawing: Drawing, story: StoryDetail, form: PlanForm): RenderElement | false => {
  const { Box, Text } = drawing.elements

  return (
    story.decisionsForYou.length > 0 && (
      <Box key={DECISIONS_KEY} flexDirection="column" gap={1}>
        <Text bold>{DECISIONS_FOR_YOU}</Text>
        {story.decisionsForYou.map((decision, index) => decisionOf(drawing, { story, form, decision, index }))}
        {isDecisionsSent(story) ? sentLines(drawing, 'decision-answers-sent', yourWords(story.decisionWordsSent)) : decisionsForm(drawing, story, form)}
      </Box>
    )
  )
}

const ALREADY_DECIDED = 'Already decided'

const alreadyDecidedOf = (drawing: Drawing, decided: string): RenderElement | false => {
  const { Box, Markdown, Text } = drawing.elements

  return (
    decided.trim() !== '' && (
      <Box key="already-decided" flexDirection="column">
        <Text bold>{ALREADY_DECIDED}</Text>
        <Markdown text={decided} />
      </Box>
    )
  )
}

// What the yes accepts unseen, so it sits right above it, one row each: observed on a real board, whole decisions here
// took about 20 rows and pushed the yes off the first screen. The full text follows the yes.
const takenByDefaultOf = (drawing: Drawing, story: StoryDetail): RenderElement | false => {
  const { Box, Text } = drawing.elements

  return (
    story.takenByDefault.length > 0 && (
      <Box key="taken-by-default" flexDirection="column">
        <Text bold>{TAKEN_BY_DEFAULT}</Text>
        {story.takenByDefault.map((answer, index) => (
          <Text key={`taken-by-default-${index}`} wrap="truncate-end">
            {cutToColumns(answer, drawing.columns)}
          </Text>
        ))}
        <Text dimColor>{FULL_TEXT_BELOW}</Text>
      </Box>
    )
  )
}

const destinationLeadOf = (drawing: Drawing, story: StoryDetail): RenderElement | false => {
  const { Text } = drawing.elements

  return story.destinationLead !== '' && <Text key="destination">{story.destinationLead}</Text>
}

const destinationRestOf = (drawing: Drawing, story: StoryDetail): RenderElement | false => {
  const { Markdown } = drawing.elements

  return story.destinationRest !== '' && <Markdown key="destination-rest" text={story.destinationRest} />
}

// Seen in a real run: the decisions sat under the analysis, the path and every excerpt, so the person scrolled past
// all of it to answer. After the short version open decisions come first; with none, the path leads and what was
// decided closes.
const destinationOf = (drawing: Drawing, story: StoryDetail): RenderElement | false => {
  const { Text } = drawing.elements

  return story.destination !== '' && <Text key="destination">{story.destination}</Text>
}

// The chat points at the board, so the short version leads: one Markdown block, no gaps between its parts.
const inShortOf = (drawing: Drawing, story: StoryDetail): RenderElement | false => {
  const { Markdown } = drawing.elements

  return story.inShort !== '' && <Markdown key="in-short" text={story.inShort} />
}

const planReading = (drawing: Drawing, story: StoryDetail): (RenderElement | false)[] => [
  destinationOf(drawing, story),
  pathDrawing(drawing.elements, story.path),
  analysisOf(drawing, story),
  excerptsDrawing(drawing.elements, story.excerpts),
]

const sayAboutThePlan = (drawing: Drawing, story: StoryDetail, form: PlanForm): RenderElement =>
  sayField(drawing, {
    key: 'say-about-story',
    sendKey: 'send-story-remark',
    label: 'Say something about this plan',
    whereWordsGo: SAID_ABOUT_THE_PLAN,
    typed: form.id === story.id ? form.typed : '',
    remarkSent: form.id === story.id ? form.remarkSent : '',
    onInput: typed => drawing.actions.typePlanWords(story.id, typed),
    onKeep: typed => drawing.actions.keepPlanWords(story.id, typed),
    onSend: () => drawing.actions.sendStoryRemark(story.id),
  })

const proposedTicketBlock = (drawing: Drawing, ticket: ProposedTicket): RenderElement => {
  const { Box, Markdown, Text } = drawing.elements

  return (
    <Box key={`proposed-${ticket.id}`} borderStyle="round" {...(ticket.changed ? { borderColor: 'claude' } : {})} paddingX={1} flexDirection="column">
      <Text bold>{ticket.changed ? `${ticket.title} ${CHANGED_STEP}` : ticket.title}</Text>
      {ticket.what !== '' && <Markdown key={`proposed-${ticket.id}-what`} text={ticket.what} />}
      {ticket.doneWhen !== '' && <Markdown key={`proposed-${ticket.id}-done-when`} text={`Done when:\n${ticket.doneWhen}`} />}
    </Box>
  )
}

const proposedTicketsOf = (drawing: Drawing, story: StoryDetail): RenderElement => {
  const { Box, Text } = drawing.elements

  return (
    <Box key="proposed-tickets" flexDirection="column" gap={1}>
      <Text bold>{PROPOSED_TICKETS}</Text>
      {story.proposedTickets.map(ticket => proposedTicketBlock(drawing, ticket))}
    </Box>
  )
}

const correctionField = (drawing: Drawing, story: StoryDetail, form: PlanForm): RenderElement => {
  const { Box, Button, Input } = drawing.elements

  return (
    <Box key="correction" flexDirection="column">
      <Input
        key="correction-words"
        label={CORRECTION_LABEL}
        value={form.id === story.id ? form.typed : ''}
        submitLabel={ENTER_KEEPS}
        onInput={typed => void drawing.actions.typePlanWords(story.id, typed)}
        onSubmit={typed => void drawing.actions.keepPlanWords(story.id, typed)}
      />
      <Button key="send-correction" label="Send the correction" onPress={() => drawing.actions.sendPlanAnswers(story.id)} />
    </Box>
  )
}

// An open decision's own words field serves as the correction too, so a view never has two.
const yesToThePlanOf = (drawing: Drawing, story: StoryDetail, form: PlanForm): RenderElement => {
  const { Box, Button, Text } = drawing.elements
  if (story.playbackAnswerSent !== '') return sentLines(drawing, 'playback-answer-sent', sentWords(story.playbackAnswerSent))

  return (
    <Box key="yes-to-the-plan" flexDirection="column" gap={1}>
      {story.decisionsForYou.length === 0 && correctionField(drawing, story, form)}
      <Box flexDirection="column">
        <Button key="yes-build-it" label={YES_BUILD_IT} onPress={() => drawing.actions.sayYesToPlan(story.id)} />
        <Text dimColor>{YES_WORDS}</Text>
      </Box>
    </Box>
  )
}

// Seen in a real run: `Yes, build it` sat on row 184 of an 80-column pane that shows about 45. So the destination's
// first paragraph, what was taken by default, an open decision and the yes lead; the rest of the destination, the
// tickets in full, every decision and the long read follow.
const playbackParts = (drawing: Drawing, story: StoryDetail, form: PlanForm): (RenderElement | false)[] => [
  destinationLeadOf(drawing, story),
  takenByDefaultOf(drawing, story),
  story.decisionsForYou.length > 0 && decisionsForYouOf(drawing, story, form),
  yesToThePlanOf(drawing, story, form),
  destinationRestOf(drawing, story),
  proposedTicketsOf(drawing, story),
  alreadyDecidedOf(drawing, story.decided),
  inShortOf(drawing, story),
  pathDrawing(drawing.elements, story.path),
  analysisOf(drawing, story),
  excerptsDrawing(drawing.elements, story.excerpts),
]

const planParts = (drawing: Drawing, story: StoryDetail, form: PlanForm): (RenderElement | false)[] => {
  if (story.proposedTickets.length > 0) return playbackParts(drawing, story, form)
  if (story.decisionsForYou.length > 0) return [inShortOf(drawing, story), decisionsForYouOf(drawing, story, form), ...planReading(drawing, story)]

  return [inShortOf(drawing, story), ...planReading(drawing, story), alreadyDecidedOf(drawing, story.decided), sayAboutThePlan(drawing, story, form)]
}

const storyView = (drawing: Drawing, story: StoryDetail, props: RenderPropsOf['Pane'], form: PlanForm): RenderElement => {
  const { Box, Button, Text } = drawing.elements
  const cue = storyScrollCue(story, scrollWindowOf(props), drawing.columns)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{story.title}</Text>
        {cue !== undefined && <Text dimColor>{cue}</Text>}
      </Box>
      {planParts(drawing, story, form)}
      <Button key="back-from-story" label="Back" onPress={drawing.actions.closeStory} />
    </Box>
  )
}

const transcriptPress = (drawing: Drawing, agent: FinishedAgentDetail): RenderElement | false => {
  const { Button, Text } = drawing.elements
  if (agent.transcript === 'gone') return <Text dimColor>{NO_TRANSCRIPT_WORDS}</Text>

  return agent.transcript === 'viewable' && <Button key={`view-${agent.agentId}`} label="View" onPress={() => drawing.actions.viewAgent(agent.agentId)} />
}

const reportOf = (drawing: Drawing, agent: FinishedAgentDetail): RenderElement => {
  const { Markdown, Text } = drawing.elements

  return agent.report.trim() === '' ? <Text dimColor>{NO_REPORT_WORDS}</Text> : <Markdown text={agent.report} />
}

// The presses sit above the report so a long one never pushes Back out of reach.
const finishedAgentView = (drawing: Drawing, agent: FinishedAgentDetail, props: RenderPropsOf['Pane']): RenderElement => {
  const { Box, Button, Text } = drawing.elements
  const cue = readingScrollCue([agent.asked, agent.report], scrollWindowOf(props), drawing.columns)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{agent.title}</Text>
        <Text dimColor>{agent.facts}</Text>
        {cue !== undefined && <Text dimColor>{cue}</Text>}
      </Box>
      {agent.asked !== '' && <Text>{`Asked: ${agent.asked}`}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {transcriptPress(drawing, agent)}
        <Button key="back-from-finished-agent" label="Back" onPress={drawing.actions.closeFinishedAgent} />
      </Box>
      {reportOf(drawing, agent)}
    </Box>
  )
}

const listShown = (state: BoardPaneState, actions: BoardPaneActions): ListShown | undefined => {
  if (state.setAside) return { lines: state.setAside, backKey: 'back-from-set-aside', onBack: actions.closeSetAside }
  if (state.older) return { lines: state.older, backKey: 'back-from-older', onBack: actions.closeOlder }
  if (state.moreFinished) return { lines: state.moreFinished, backKey: 'back-from-more-finished', onBack: actions.closeMoreFinished }

  return undefined
}

const boardOrList = (drawing: Drawing, state: BoardPaneState): RenderElement => {
  const list = listShown(state, drawing.actions)

  return list === undefined ? linesView(drawing, state.lines, state.props) : listView(drawing, list, state.props)
}

const openedView = (drawing: Drawing, state: BoardPaneState): RenderElement => {
  if (state.story) return storyView(drawing, state.story, state.props, state.forms.plan)
  if (state.detail) return detailView(drawing, state.detail, state.forms.ticket)
  if (state.finishedAgent) return finishedAgentView(drawing, state.finishedAgent, state.props)

  return boardOrList(drawing, state)
}

export const drawBoardPane = (elements: BoardElements, state: BoardPaneState, actions: BoardPaneActions): RenderElement => {
  const { Text } = elements
  const drawing: Drawing = { elements, actions, columns: state.props.bodyColumns }
  if (state.props.placement === 'widget') return <Text>{widgetCounts(state.summary)}</Text>

  return openedView(drawing, state)
}
