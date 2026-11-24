import type { ElementTable } from 'claude-code'

import {
  NOTICED_HEADING,
  NOTICED_HINT,
  NOTHING_TO_SHOW,
  REASON_LABEL,
  WAITING_HEADING,
  WHAT_EACH_ANSWER_DOES,
  WHAT_EACH_PRESS_DOES,
  expectationLine,
  noticedCandidates,
  proposalInWords,
  proposalsInSight,
  seenBetween,
  whyItWasProposed,
} from './inbox'
import type { Candidate, ProposalCard, Records } from './inbox'
import type { QuartermasterInboxView } from '../../types'

export type InboxElements = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Input' | 'Markdown'>

export type InboxActions = {
  showProposal: (id: string) => void
  showCandidate: (fingerprint: string) => void
  approve: (id: string) => void
  reject: (id: string) => void
  typeReason: (reason: string) => void
  later: (id: string) => void
  draft: (fingerprint: string) => void
  notNow: (fingerprint: string) => void
  never: (fingerprint: string) => void
  back: () => void
}

export type InboxContent = { records: Records; candidates: readonly Candidate[]; view: QuartermasterInboxView }

const section = ({ Box, Text }: InboxElements, title: string, rows: readonly JSX.Element[]) =>
  rows.length === 0 ? null : (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      {rows}
    </Box>
  )

const proposalRow = ({ Button }: InboxElements, card: ProposalCard, actions: InboxActions) => (
  <Button key={card.id} plain onPress={() => actions.showProposal(card.id)}>
    {proposalInWords(card)}
  </Button>
)

const candidateRow = ({ Button }: InboxElements, candidate: Candidate, actions: InboxActions) => (
  <Button key={candidate.fingerprint} plain onPress={() => actions.showCandidate(candidate.fingerprint)}>
    {candidate.sentence}
  </Button>
)

export const inboxList = (elements: InboxElements, content: InboxContent, actions: InboxActions) => {
  const { Box, Text } = elements
  const waiting = proposalsInSight(content.records).map(card => proposalRow(elements, card, actions))
  const noticed = noticedCandidates(content.candidates, content.records).map(candidate =>
    candidateRow(elements, candidate, actions),
  )
  const isEmpty = waiting.length + noticed.length === 0

  return (
    <Box flexDirection="column">
      {isEmpty && <Text dimColor>{NOTHING_TO_SHOW}</Text>}
      {section(elements, WAITING_HEADING, waiting)}
      {section(elements, NOTICED_HEADING, noticed)}
      {noticed.length > 0 && <Text dimColor>{NOTICED_HINT}</Text>}
    </Box>
  )
}

export const proposalDetail = (
  elements: InboxElements,
  card: ProposalCard,
  candidates: readonly Candidate[],
  actions: InboxActions,
) => {
  const { Box, Text, Button, Input, Markdown } = elements

  return (
    <Box flexDirection="column">
      <Text bold>{proposalInWords(card)}</Text>
      <Markdown text={card.body} />
      {whyItWasProposed(card, candidates).map(why => (
        <Text>{why}</Text>
      ))}
      <Text>{expectationLine(card)}</Text>
      <Input
        key="reason"
        label={REASON_LABEL}
        placeholder="a few words"
        submitLabel="reject"
        onInput={actions.typeReason}
        onSubmit={reason => {
          actions.typeReason(reason)
          actions.reject(card.id)
        }}
      />
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="approve" hotkey="a" variant="primary" onPress={() => actions.approve(card.id)}>Approve</Button>
        <Button key="reject" hotkey="r" onPress={() => actions.reject(card.id)}>Reject</Button>
        <Button key="later" hotkey="l" onPress={() => actions.later(card.id)}>Later</Button>
        <Button key="back" hotkey="b" role="dismiss" onPress={actions.back}>Back</Button>
      </Box>
      <Text dimColor>{WHAT_EACH_ANSWER_DOES}</Text>
    </Box>
  )
}

export const candidateDetail = (elements: InboxElements, candidate: Candidate, actions: InboxActions) => {
  const { Box, Text, Button } = elements

  return (
    <Box flexDirection="column">
      <Text bold>{candidate.sentence}</Text>
      <Text dimColor>{seenBetween(candidate)}</Text>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="draft" hotkey="d" variant="primary" onPress={() => actions.draft(candidate.fingerprint)}>
          Draft a fix
        </Button>
        <Button key="not-now" hotkey="l" onPress={() => actions.notNow(candidate.fingerprint)}>Later</Button>
        <Button key="never" hotkey="n" onPress={() => actions.never(candidate.fingerprint)}>Ignore in this project</Button>
        <Button key="back" hotkey="b" role="dismiss" onPress={actions.back}>Back</Button>
      </Box>
      <Text dimColor>{WHAT_EACH_PRESS_DOES}</Text>
    </Box>
  )
}

/** A detail whose record has gone (applied, rejected elsewhere) falls back to the list. */
export const inboxPane = (elements: InboxElements, content: InboxContent, actions: InboxActions) => {
  const card = content.records.proposals.find(proposal => proposal.id === content.view.proposal)
  if (card !== undefined) return proposalDetail(elements, card, content.candidates, actions)
  const candidate = content.candidates.find(noticed => noticed.fingerprint === content.view.candidate)

  return candidate === undefined ? inboxList(elements, content, actions) : candidateDetail(elements, candidate, actions)
}
