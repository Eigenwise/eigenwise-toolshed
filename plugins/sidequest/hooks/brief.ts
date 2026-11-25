import type { BoardConfig, SharedThing } from './board-config'
import { buildOnEarlierWorkSection } from './build-on-earlier-work'
import { ownWorktreeSection } from './own-worktree'
import { earlierRunOf, earlierRunSection, humanAnswersSection } from './earlier-run'
import { resumeSection } from './resume-facts'
import type { ResumeFacts } from './resume-facts'
import { hasSharedThings, sharedThingsOf, thingsUsedBy } from './shared-things'
import { oneLine } from './tickets'
import type { Story, Ticket } from './tickets'

// Kept word for word with shared/result-contract.md: every routed agent returns this shape.
export const RESULT_CONTRACT = `# Result contract

What a routed agent hands back. Your last message is the return value, not a note to a person.

- \`result\`: what is now true, in one or two sentences.
- \`checked\`: the exact command you ran to check it and its exit code, or \`not checked\` and why.
- \`uncertain\`: anything you assumed, skipped or could not verify. Empty is a claim, so only leave it empty when it is.
- \`needs\`: a decision or action only the human can take, or \`nothing\`.
- \`branch\`: the branch your commits are on, when you wrote code.
- \`commits\`: how many.
- \`changedFiles\`: the paths you changed.

Report what happened, not what you hoped. A check that did not run is \`not checked\`, never a pass.`

export const ticketRefLine = (ticket: Ticket): string => `Ticket ${ticket.id}: ${ticket.title}`

// Measured on 2026-11-23: with the rule only in the worker's own page, a worker with no tracker key still began its
// commit subjects with the board id in 2 of 2 commits. Here it sits beside the id it is about.
export const outwardRule = (ticket: Ticket): string =>
  `## What leaves this machine
${ticket.id} is a board id for this machine only. Commit messages, branch names, code comments and committed files speak of the work in the project's terms: ${ticket.issue === undefined ? 'what changed and how it was checked' : `the tracker key ${ticket.issue}, what changed and how it was checked`}. Never a board id, this tool or its words (worker, scout, wave, brief).`

// The agent starts fresh and sees only this, so what the human agreed to has to travel with the ticket.
const DECISION_START = /^- (D-\d+)\b/

export const namedDecisionsOnly = (decisionsText: string, namedIds: readonly string[]): string => {
  if (namedIds.length === 0) return decisionsText
  let isNamed = false
  const keptLines = decisionsText.split('\n').filter(line => {
    const startedId = DECISION_START.exec(line.trim())?.[1]
    if (startedId !== undefined) isNamed = namedIds.includes(startedId)
    return isNamed
  })

  return keptLines.join('\n')
}

const storySections = (story: Story | undefined, ticket: Ticket): string[] => {
  if (!story) return []
  const decisions = namedDecisionsOnly(story.decisions, ticket.decisions)

  return [
    story.destination ? `## Where this is going\n${story.destination}` : '',
    decisions ? `## Decisions already made\n${decisions}` : '',
  ].filter(section => section !== '')
}

const deliverySection = (delivery: string | undefined): string[] =>
  delivery ? [`## Delivery\n${delivery}`] : []

export type SharedRun = { config: BoardConfig; isIsolated: boolean; branchToMerge?: string }

const HOLDS_RULE =
  'What this run holds is yours for this run: leave it as you found it, restore any data you change and say so in your result.'

const NOT_HELD_RULE = 'What this run does not hold: do not start, stop, restart or write to it, and never stop a process you did not start.'

// In 2026-11-19's baseline a session killed the person's server to make it serve landed code, and a worker in a
// worktree cannot prove anything against an application that runs another folder's code.
const notHeldCheckRule = (isIsolated: boolean): string =>
  `${isIsolated ? 'The running application serves the main checkout, not your worktree, so a' : 'A'} check that needs it is not yours to run: report it as not checked with that reason. The proof happens after landing.`

const sharedThingLine = (name: string, thing: SharedThing, isHeld: boolean): string =>
  `- ${name}: ${oneLine(thing.what).replace(/\.$/, '')}. ${isHeld ? 'This run holds it.' : 'This run does not hold it.'}`

const sharedRules = (heldCount: number, notHeldCount: number, isIsolated: boolean): string[] => [
  ...(heldCount > 0 ? [HOLDS_RULE] : []),
  ...(notHeldCount > 0 ? [`${NOT_HELD_RULE} ${notHeldCheckRule(isIsolated)}`] : []),
]

const sharedHereSection = (ticket: Ticket, run: SharedRun | undefined): string[] => {
  if (run === undefined || !hasSharedThings(run.config)) return []
  const held = thingsUsedBy(ticket, run.config)
  const things = Object.entries(sharedThingsOf(run.config))
  const lines = things.map(([name, thing]) => sharedThingLine(name, thing, held.includes(name)))
  const heldCount = things.filter(([name]) => held.includes(name)).length
  const rules = sharedRules(heldCount, things.length - heldCount, run.isIsolated)

  return [['## Shared here', 'These exist once in this project, and one run at a time holds each.', ...lines, '', ...rules].join('\n')]
}

const checksSection = (run: SharedRun | undefined): string[] => {
  const checks = run?.config.settings.checks

  return checks === undefined ? [] : [`## How checks run here
${checks}`]
}

const PERSONS_WORDS = /in the person['\u2019]s words:/i

export const PERSONS_WORDS_RULE =
  "A line in the person's words is met exactly as written. When it cannot be, stop and say so in `needs`: never reinterpret or loosen it."

// The plan skill files a check the person worded with that marker, so whoever builds or reviews it reads the rule beside it.
const doneWhenSection = (ticket: Ticket): string => {
  const doneWhen = ticket.doneWhen || '(not written yet)'

  return PERSONS_WORDS.test(doneWhen) ? `## Done when\n${doneWhen}\n\n${PERSONS_WORDS_RULE}` : `## Done when\n${doneWhen}`
}

// A section the board has no field for is still part of what was asked: one written by hand, or one a version before
// 0.42.4 split off when a session wrote `## Approach` inside a field. Seen twice: a worker's brief came without the approach.
const sectionsWithNoField = (ticket: Ticket): string[] => ticket.otherSections.map(section => `## ${section.heading}\n${section.text}`)

export const briefFor = (ticket: Ticket, story?: Story, delivery?: string, sharedRun?: SharedRun, resume?: ResumeFacts, noGitFolder?: string): string =>
  [
    ticketRefLine(ticket),
    ...(noGitFolder === undefined ? [] : ownWorktreeSection(noGitFolder)),
    ...buildOnEarlierWorkSection(ticket, sharedRun?.isIsolated === true && noGitFolder === undefined, sharedRun?.branchToMerge),
    ...storySections(story, ticket),
    `## What\n${ticket.what || '(not written yet)'}`,
    doneWhenSection(ticket),
    ...sectionsWithNoField(ticket),
    ...earlierRunSection(earlierRunOf(ticket)),
    ...humanAnswersSection(ticket),
    ...resumeSection(resume, earlierRunOf(ticket)?.branch),
    ...checksSection(sharedRun),
    ...sharedHereSection(ticket, sharedRun),
    ...deliverySection(delivery),
    outwardRule(ticket),
    RESULT_CONTRACT,
  ].join('\n\n')
