// Every name, ticket, cost and session id the pictures show starts here. All of it is invented: the project names,
// the tracker key, the people's words and the numbers. Keep it that way: no real project, person, company or path.

export const SIDEQUEST_PROJECT = 'photo-library'
export const UPGRADE_PROJECT = 'trip-notes'
export const TRACKER_KEY = 'PAY'
export const PIECE_OF_WORK = 'PAY-41'
export const WORK_BRANCH = 'PAY-41-retry'

// The clock every picture is drawn at, and where each moment of the made-up session starts.
export const FIRST_MINUTE = Date.parse('2026-11-16T10:00:00Z')

export const PERSON_ASKS = "Let's do PAY-41"

export const IN_SHORT = [
  'Asked: A failed photo upload is tried once more, and the import summary lists the photos that still failed.',
  '',
  'Today: Every upload goes through `uploadPhoto()`. A failed one is counted, and the summary shows only the count.',
  '',
  'Found: The share sheet uses `uploadPhoto()` too, so a retry inside it changes that path as well.',
  '',
  'Options: A: retry inside `uploadPhoto()`, every caller gets it (recommended). B: retry in the import loop, smaller, the share sheet stays as it is.',
].join('\n')

export const ANALYSIS = [
  '### What is asked',
  '',
  'PAY-41 asks that a failed photo upload is tried once more, and that the import summary lists the photos that still failed.',
  '',
  '### How it works today',
  '',
  'Every upload goes through `uploadPhoto()`. A failed one is counted, and the summary shows only the count.',
  '',
  '### Options',
  '',
  '**A. Retry inside `uploadPhoto()`.** Every caller gets it, the share sheet too. Recommended.',
  '',
  '**B. Retry in the import loop.** Smaller change. The share sheet stays as it is.',
].join('\n')

export const CODE_PATH = [
  { what: 'Import picks the photos', file: 'src/import/run-import.ts', line: 18 },
  { what: 'Each photo is uploaded', file: 'src/upload/client.ts', line: 41, changed: true, note: 'tries once more' },
  { what: 'A failure is counted', file: 'src/import/import-result.ts', line: 9, changed: true, note: 'keeps the photo, not only a count' },
  { what: 'The summary is drawn', file: 'src/import/ImportSummary.tsx', line: 22, changed: true, note: 'lists what failed' },
]

export const PLAN_QUESTIONS = [
  {
    question: 'How does a caller say how often an upload is retried?',
    recommended: ['`retries: number`', 'default `1`'],
    otherCosts: 'A boolean `retry` is shorter, but a second retry later changes the signature.',
  },
  {
    question: 'Where does the retry live?',
    recommended: 'Inside `uploadPhoto()`, so the share sheet retries too.',
    otherCosts: 'In the import loop, only imports retry.',
  },
  {
    question: 'The mockup has a "Try again" button the text does not ask for. Build it now?',
    recommended: ['Leave it out of PAY-41.'],
    otherCosts: 'Building it now adds a third ticket.',
  },
]

// The person's answers, sent from the plan's form: the recommended answer for 1 and 2, the other answer for 3, and
// their own words with it.
export const OTHER_ANSWERS_PICKED = [2]
export const PERSONS_OWN_WORDS = 'Build the button. It is why the mockup changed.'

export const PLAN_DECISIONS = [
  { question: PLAN_QUESTIONS[0]?.question, answer: '`retries: number`, default 1.', decidedBy: 'human' },
  { question: PLAN_QUESTIONS[1]?.question, answer: 'Inside `uploadPhoto()`.', decidedBy: 'human' },
  { question: PLAN_QUESTIONS[2]?.question, answer: 'Build it. It is why the mockup changed.', decidedBy: 'human' },
  { question: 'How is it proven?', answer: 'An import of 12 photos, 3 with the network cut.', decidedBy: 'default' },
  { question: 'Where does it end?', answer: 'One pull request for PAY-41.', decidedBy: 'default' },
]

export const DESTINATION = 'A failed upload is tried once more, and the summary lists what still failed, with a way to try those again.'
export const OUT_OF_SCOPE = 'Resumable uploads. Background sync.'

// The first two are built side by side; the third needs the second.
export const PLAN_TICKETS = [
  {
    title: 'Retry a failed upload once before giving up',
    what: '`uploadPhoto(photo, { retries = 1 })` in src/upload/client.ts. Test: "retries once, then reports the failure".',
    doneWhen: 'An upload that fails once goes through on the second try, and one that fails twice is reported once.',
  },
  {
    title: 'Show which photos failed to upload',
    what: '`ImportSummary` takes `failed: Photo[]` and lists them by file name. Test: "lists each failed photo".',
    doneWhen: 'An import with 3 failures shows those 3 names.',
  },
  {
    title: 'Try the failed photos again',
    what: 'A "Try again" button on the summary calls `retryFailed(importId)`. Test: "retries only the failed photos".',
    doneWhen: 'Pressing it uploads the 3 failed photos and no others.',
  },
]

// The host's agent ids and models for the agents the board shows running, one per ticket in build order.
export const AGENTS = [
  { agentId: 'agent-0001', model: 'claude-sonnet-5-5', minutes: 7, report: 'uploadPhoto() retries once after a failed PUT. 6 tests, all pass.' },
  { agentId: 'agent-0002', model: 'claude-sonnet-5-5', minutes: 6, report: 'ImportSummary lists each failed photo by file name. 4 tests, all pass.' },
  { agentId: 'agent-0003', model: 'claude-sonnet-5-5', minutes: 5, report: 'Try again uploads only the photos in the failed list. 6 tests, all pass.' },
]

export const CHECKED = 'npm test exit 0, 16 tests'

export const WHAT_CHANGED = {
  changed: [
    '- Upload: `uploadPhoto()` tries once more before it reports a failure.',
    '- Import result: keeps each failed photo, not only a count.',
    '- Summary: lists the failed photos, with "Try again".',
    '',
    'The whole diff: `git diff main...PAY-41-retry`',
  ].join('\n'),
  checked: ['- `npm test`: 16 tests pass.', '- An import of 12 photos with the network cut for 3: all 3 retried, 1 still failed and is listed.'].join('\n'),
  hunks: [
    '--- a/src/upload/client.ts',
    '+++ b/src/upload/client.ts',
    '@@ -41,4 +41,7 @@',
    '-export const uploadPhoto = async (photo: Photo): Promise<UploadResult> => {',
    '+export const uploadPhoto = async (photo: Photo, { retries = 1 } = {}): Promise<UploadResult> => {',
    '   const response = await put(uploadUrlOf(photo), photo.bytes)',
    '-  return response.ok ? uploaded(photo) : failed(photo, response.status)',
    '+  if (response.ok) return uploaded(photo)',
    '+  if (retries > 0) return uploadPhoto(photo, { retries: retries - 1 })',
    '+  return failed(photo, response.status)',
    ' }',
  ].join('\n'),
}

export const REVIEW_NOTE = 'review pass: does what the ticket says, tests cover both tries.'

export const COMMIT_QUESTION = {
  question: 'Commit, push and open the pull request?',
  whyNow: 'The three changes are built, reviewed and proven on a made-up import. Nothing is committed yet.',
  options: [
    { label: 'Commit, push and open the pull request', gets: 'PAY-41 is up for review with the text shown here.', costs: 'Your reviewers are notified.' },
    { label: 'Commit only', gets: 'The change is on PAY-41-retry in your checkout.', costs: 'Nobody sees it until you push.' },
  ],
  recommended: 'Commit, push and open the pull request.',
  ifUnanswered: 'The change stays uncommitted on PAY-41-retry.',
  alsoYours: [{ what: 'The review noted the retry has no delay between tries.', doneByDefault: 'Left as it is.' }],
  sayingYesTo: {
    reviewFound: 'Passed. One note: the retry has no delay between the two tries.',
    commitMessage: 'PAY-41 Retry a failed upload and list what still failed\n\nuploadPhoto() tries once more before it reports a failure. The import summary lists the failed photos and can try them again.',
    pullRequestTitle: 'PAY-41 Retry a failed upload and list what still failed',
    pullRequestDescription: '- A failed upload is tried once more, for imports and the share sheet.\n- The import summary lists the photos that still failed.\n- "Try again" uploads only those.\n\nChecked: 16 tests, and an import of 12 photos with the network cut for 3.',
  },
}

export const PERSON_PICKS = 'A. Commit, push and open the pull request'
export const PULL_REQUEST = 'https://git.example/photo-library/pull/1'
export const MINUTES_TO_OPEN_THE_PULL_REQUEST = 3

// Quartermaster in the same project. The person typed the thumbnail build by hand over three days before PAY-41, and
// a round at the end of the third day's session turned that into a proposal that waits in the inbox.
export const PROPOSAL = {
  id: 'P-0001',
  kind: 'script',
  target: 'npm run build:thumbs',
  status: 'offered',
  authority: 'ask',
  expect: 'hand runs of `npm run build:thumbs` per week',
  baseline: 14,
  created: '2026-11-14',
  body: '## What\nAdd a `thumbs` script to package.json that runs the thumbnail build and its check in one step.\n\n## Rollback\nDelete the `thumbs` line from package.json.',
} as const

// Each one a time the person typed the build command by hand, over three days.
export const TYPED_BUILD_RUNS = [
  '2026-11-12T09:10:00Z', '2026-11-12T10:40:00Z', '2026-11-12T13:05:00Z', '2026-11-12T15:30:00Z', '2026-11-12T16:55:00Z',
  '2026-11-13T09:20:00Z', '2026-11-13T11:00:00Z', '2026-11-13T14:15:00Z', '2026-11-13T16:45:00Z',
  '2026-11-14T09:05:00Z', '2026-11-14T10:30:00Z', '2026-11-14T13:50:00Z', '2026-11-14T15:20:00Z', '2026-11-14T16:00:00Z',
]
export const TYPED_COMMAND = 'npm run build:thumbs'

// During the PAY-41 build the agents tried the import proof and were blocked each time: the standing yes they lacked.
export const DENIED_COMMAND = 'npm run test:import'
export const DENIED_RUNS = ['2026-11-16T10:14:00Z', '2026-11-16T10:16:00Z', '2026-11-16T10:21:00Z', '2026-11-16T10:27:00Z']

// What a press on Draft a fix turned that into: a permission proposal, the standing yes.
export const STANDING_YES = {
  id: 'P-0002',
  kind: 'permission',
  target: DENIED_COMMAND,
  status: 'offered',
  authority: 'ask',
  expect: 'times an agent is blocked running `npm run test:import` per week',
  baseline: 4,
  created: '2026-11-16',
  body: '## What\nAdd `Bash(npm run test:import)` to `permissions.allow` in `.claude/settings.local.json`, so an agent can run the import proof without asking.\n\n## Rollback\nDelete that line from `.claude/settings.local.json`.',
} as const

// Quartermaster names a session's event file by the minute the session started, in base 36.
export const quartermasterSessionTagOn = (day: string): string => Date.parse(`${day}T08:55:00Z`).toString(36)

// What the older Toolshed left in the made-up project the upgrade scans.
export const OLDER_RULE_FILE = { path: '.claude/live-rules/rules/naming.md', text: "---\nglobs: ['src/**']\n---\nName things by what they hold.\n" }
export const OLDER_MAP_FILE = { path: '.claude/.codebase-info/INDEX.md', text: '# Map\n\n- src/trips: the trip list and its editor\n' }
// The older plugins the made-up project had switched on. Their keys name the product's own marketplace, so the
// scan can recognise them; that name comes from the plugin, not from here.
export const OLDER_PLUGINS_ON = ['sidequest', 'live-rules', 'codebase-mapper', 'quality-gate']
export const PROJECT_FILE = { path: 'README.md', text: '# trip-notes\n\nNotes for trips that have not happened.\n' }
export const MADE_UP_AUTHOR = 'example-author'
export const MADE_UP_COMMIT_DATE = '2026-11-01T12:00:00Z'

// The usage page shows the same project: three days of thumbnail work before PAY-41, then the PAY-41 session itself,
// whose turns come from the story. Each earlier session runs from 09:00 to 17:00, so the hand runs fall inside it.
// The sessions run on SESSION_MODEL; the PAY-41 agents on theirs. Paths are made up.
export const USAGE_PROJECT_PATH = '/work/photo-library'
export const SESSION_MODEL = 'claude-opus-5-5'
export const EARLIER_SESSIONS = [
  { day: '2026-11-12', prompt: 'Thumbnails of portrait photos come out sideways', turns: 6 },
  { day: '2026-11-13', prompt: 'Rebuild the thumbnails after the resize change', turns: 4 },
  { day: '2026-11-14', prompt: 'Why does build:thumbs take four minutes?', turns: 5 },
]
export const USAGE_SEED = 41
export const CLAUDE_VERSION = '2.1.400'
