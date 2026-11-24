export const meta = {
  name: 'wave',
  description: 'Run a wave of Sidequest tickets: each ticket on its routed agent, then an independent read-only review of that ticket unless the ticket says review false. Returns one result per ticket for the main session to record.',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}

const RESULT_CONTRACT = {
  type: 'object',
  properties: {
    result: { type: 'string', description: 'What is now true, in one or two sentences.' },
    checked: { type: 'string', description: 'The exact command run and its exit code, or "not checked" and why.' },
    uncertain: { type: 'string', description: 'Anything assumed, skipped or not verified.' },
    needs: { type: 'string', description: 'A decision or action only the human can take, or "nothing".' },
    branch: { type: 'string', description: 'The branch the commits are on (git branch --show-current), never empty when code was written; empty when none was.' },
    commits: { type: 'integer', description: 'How many commits.' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'The paths changed, relative to the repository root, never absolute.' },
  },
  required: ['result', 'checked', 'uncertain', 'needs', 'branch', 'commits', 'changedFiles'],
}

const REVIEW_VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    result: { type: 'string', description: 'What the review found, each problem (behaviour, or a clear break of a written guideline) with its evidence and the smallest fix.' },
    checked: { type: 'string', description: 'The exact command run and its exit code, or "not checked" and why.' },
    uncertain: { type: 'string', description: 'Anything assumed, skipped or not verified.' },
    needs: { type: 'string', description: 'A decision only the human can make, or "nothing".' },
  },
  required: ['verdict', 'result', 'checked', 'uncertain', 'needs'],
}

const NO_RESULT = 'The agent died or returned nothing. Call finish with outcome failed, and write no review note for this ticket.'

const wave = typeof args === 'string' ? JSON.parse(args) : args

function implementOptions(ticket) {
  const isolation = ticket.worktree ? { isolation: 'worktree' } : {}
  return {
    label: ticket.id,
    phase: 'Implement',
    agentType: ticket.agentType,
    model: ticket.model,
    effort: ticket.effort,
    schema: RESULT_CONTRACT,
    ...isolation,
  }
}

function implementPrompt(ticket) {
  return [
    `Ticket ${ticket.id}: ${ticket.title}`,
    `Your brief is in the file ${ticket.briefFile}. Read it in full first, by that absolute path, then do the ticket as it says.`,
  ].join('\n\n')
}

function reviewPrompt(ticket, run) {
  return [
    `${ticket.id} [route:review] Review the work for this ticket.`,
    `The brief the agent was given is in the file ${ticket.briefFile}. Read it in full first, by that absolute path.`,
    `What the agent reported:\n\n${JSON.stringify(run, null, 2)}`,
    `Read the diff on branch ${run.branch || '(none reported)'} against its base and check it against the brief and its Done when. Run that check where you can without writing files, and read the real exit code. When you find one problem, look for the same problem everywhere else in the change. Also check the diff against the project's written guidelines: rules files in .claude/rules/ whose paths match the touched files (no paths means all), a contributing or style page, and linter or formatter config in the repository. A clear break of a written guideline is a fail; name the file that states it, the file and line that break it, and the smallest fix. A rule not written in the repository is only a note beside a pass. Set verdict to pass or fail.`,
  ].join('\n\n')
}

function implement(ticket) {
  return agent(implementPrompt(ticket),implementOptions(ticket))
}

function review(run, ticket) {
  if (run === null) return { id: ticket.id, run, review: null, outcome: 'failed', result: NO_RESULT }
  if (ticket.review === false) return { id: ticket.id, run, review: null }
  return agent(reviewPrompt(ticket, run), {
    label: `review:${ticket.id}`,
    phase: 'Review',
    agentType: 'sidequest:scout',
    ...wave.reviewRoute,
    schema: REVIEW_VERDICT,
  }).then((verdict) => ({ id: ticket.id, run, review: verdict }))
}

const results = await pipeline(wave.tickets, implement, review)
return { results }
