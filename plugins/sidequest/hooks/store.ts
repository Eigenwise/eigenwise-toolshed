import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { configDirectoryOf } from './config-directory.mjs'
import { DEFAULT_BOARD_CONFIG, isRecord, mergeBoardConfig, serializeBoardConfig } from './board-config'
import type { BoardConfig } from './board-config'
import {
  changedOnDiskNote,
  filedUnderAnotherIdNote,
  folderContentsOf,
  freeIdFrom,
  notFiledAfterTriesNote,
  notFiledNote,
  notWrittenNote,
  STORY_READING,
  storyNamed,
  TICKET_READING,
  ticketNamed,
  ticketWithRenamedReferences,
} from './board-folder'
import type { BoardFolder, FileRead, FolderContents, ItemReading, UnusableFile } from './board-folder'
import { boardIdsOf, EARLIER_BOARD_IDS, nextNumberAfter } from './board-ids'
import type { BoardIds } from './board-ids'
import { boardJsonWrittenAgainNotice, hasWorkOnDisk, isBlank, VANISHED_BOARD_NOTICE } from './board-notices'
import { choosePrefix, prefixFactsFrom, withPrefixFromDisk } from './board-prefix'
import type { PrefixFacts } from './board-prefix'
import { branchInHead } from './branch-and-issue'
import { projectNameOf } from './project-name'
import { NO_PROVIDERS, providersOf } from './routing'
import type { Providers } from './routing'
import { serializeStory, serializeTicket } from './tickets'
import type { Story, Ticket } from './tickets'

type Engine = Pick<EngineInterface, 'fs' | 'process' | 'env'>

// `checkoutGitDir` is a linked worktree's own git folder; absent when the checkout uses the common one.
export type BoardLocation = { root: string; gitCommonDir?: string; checkoutGitDir?: string }

// `unusableFiles` and `idsOnDisk` come from a read of the folders; a board put together in memory has neither.
export type BoardFiles = {
  config: BoardConfig
  configText: string | undefined
  tickets: Ticket[]
  stories: Story[]
  checkedOutBranch?: string
  projectName?: string
  folderRead?: string
  unusableFiles?: readonly UnusableFile[]
  idsOnDisk?: { tickets: readonly string[]; stories: readonly string[] }
}

export type BoardChange = { tickets: Ticket[]; stories: Story[]; config?: BoardConfig }

const BOARD_FOLDER = '.sidequest'

const joinPath = (...parts: string[]): string => parts.join('/')
const trimTrailingSlash = (path: string): string => path.replace(/[\\/]+$/, '')

const boardPath = (location: BoardLocation, ...parts: string[]): string =>
  joinPath(trimTrailingSlash(location.root), BOARD_FOLDER, ...parts)

const gitFoldersFrom = (gitAnswer: ProcessRunResult | undefined): string[] =>
  gitAnswer?.exitCode === 0
    ? gitAnswer.stdout
        .split('\n')
        .map(line => trimTrailingSlash(line.trim()))
        .filter(line => line !== '')
    : []

const mainCheckoutOf = (gitCommonDir: string): string | undefined => /^(.*)[\\/]\.git$/.exec(gitCommonDir)?.[1]

const ownCheckoutDir = (gitCommonDir: string, checkoutGitDir: string | undefined): { checkoutGitDir?: string } =>
  checkoutGitDir === undefined || checkoutGitDir === gitCommonDir ? {} : { checkoutGitDir }

export const boardLocationFrom = (cwd: string, gitAnswer: ProcessRunResult | undefined): BoardLocation => {
  const [gitCommonDir, checkoutGitDir] = gitFoldersFrom(gitAnswer)
  if (gitCommonDir === undefined) return { root: cwd }

  return { root: mainCheckoutOf(gitCommonDir) ?? cwd, gitCommonDir, ...ownCheckoutDir(gitCommonDir, checkoutGitDir) }
}

// One process at session start answers both: the common folder holds the board, the checkout's own folder its HEAD.
export async function locateBoard($: Engine, cwd: string): Promise<BoardLocation> {
  const gitAnswer = await $.process
    .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], { cwd })
    .catch(() => undefined)

  return boardLocationFrom(cwd, gitAnswer)
}

export function readOptionalText($: Engine, path: string): Promise<string | undefined> {
  return readOptional($, path)
}

function readOptional($: Engine, path: string): Promise<string | undefined> {
  return $.fs.read(path).then(
    text => text,
    () => undefined,
  )
}

const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)

    return value
  } catch {
    return undefined
  }
}

async function markdownIdsIn($: Engine, folder: string): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])

  return entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.md')).map(entry => entry.name.slice(0, -3))
}

// The host puts the plugin and the call in front of the system's own words, which are what a person can act on.
const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.fs\.\w+: /, '')

function readFileOf($: Engine, folder: string, name: string): Promise<FileRead> {
  return $.fs.read(joinPath(folder, `${name}.md`)).then(
    text => ({ name, text }),
    (error: unknown) => ({ name, failure: failureOf(error) }),
  )
}

// Each file is read once: what a write compares against later is the text this read saw.
async function readBoardFolder<Item extends { id: string }>($: Engine, location: BoardLocation, reading: ItemReading<Item>): Promise<FolderContents<Item>> {
  const folder = boardPath(location, reading.folder)
  const names = await markdownIdsIn($, folder)
  const files = await Promise.all(names.map(name => readFileOf($, folder, name)))

  return folderContentsOf(reading, files)
}

// Read from the HEAD file, so knowing the branch costs no process. A detached HEAD names no branch.
async function readCheckedOutBranch($: Engine, location: BoardLocation): Promise<string | undefined> {
  const gitDir = location.checkoutGitDir ?? location.gitCommonDir
  const head = gitDir === undefined ? undefined : await readOptional($, joinPath(gitDir, 'HEAD'))

  return head === undefined ? undefined : branchInHead(head)
}

// A transcript row is drawn with no board read of its own, so it takes the ids of the board read last.
let idsOfBoardReadLast: BoardIds = EARLIER_BOARD_IDS

export const idsOfLastBoardRead = (): BoardIds => idsOfBoardReadLast

const remembered = (config: BoardConfig): BoardConfig => {
  idsOfBoardReadLast = boardIdsOf(config.prefix)

  return config
}

const configIn = (text: string | undefined): BoardConfig => (text === undefined ? DEFAULT_BOARD_CONFIG : mergeBoardConfig(parseJson(text)))

const ticketPath = (location: BoardLocation, id: string): string => boardPath(location, 'tickets', `${id}.md`)

// The text of each ticket as this read saw it, so a write can tell whether the file changed underneath it.
export type BoardRead = { files: BoardFiles; ticketTexts: ReadonlyMap<string, string> }

async function readBoardAndTexts($: Engine, location: BoardLocation): Promise<BoardRead> {
  const configText = await readOptional($, boardPath(location, 'board.json'))
  const [tickets, stories, checkedOutBranch] = await Promise.all([
    readBoardFolder($, location, TICKET_READING),
    readBoardFolder($, location, STORY_READING),
    readCheckedOutBranch($, location),
  ])
  const projectName = projectNameOf(location.root)
  const config = remembered(withPrefixFromDisk(configIn(configText), tickets.idsOnDisk, stories.idsOnDisk))
  const files: BoardFiles = {
    config,
    configText,
    tickets: tickets.items,
    stories: stories.items,
    unusableFiles: [...tickets.unusable, ...stories.unusable],
    idsOnDisk: { tickets: tickets.idsOnDisk, stories: stories.idsOnDisk },
    folderRead: boardPath(location),
    ...(checkedOutBranch === undefined ? {} : { checkedOutBranch }),
    ...(projectName === undefined ? {} : { projectName }),
  }

  return { files, ticketTexts: tickets.texts }
}

export async function readBoard($: Engine, location: BoardLocation): Promise<BoardFiles> {
  return (await readBoardAndTexts($, location)).files
}

// A read that a write can start from, so a call that needs the board before it decides reads it once.
export function readBoardForWrite($: Engine, location: BoardLocation): Promise<BoardRead> {
  return readBoardAndTexts($, location)
}

type TicketRead = { ticket: Ticket; text: string }

async function readTicketFile($: Engine, location: BoardLocation, id: string): Promise<TicketRead | undefined> {
  const text = await readOptional($, ticketPath(location, id))
  const ticket = text === undefined ? undefined : ticketNamed(id, text)

  return ticket === undefined || text === undefined ? undefined : { ticket, text }
}

export async function readTicket($: Engine, location: BoardLocation, id: string): Promise<Ticket | undefined> {
  return (await readTicketFile($, location, id))?.ticket
}

export async function readStory($: Engine, location: BoardLocation, id: string): Promise<Story | undefined> {
  const text = await readOptional($, boardPath(location, 'stories', `${id}.md`))

  return text === undefined ? undefined : storyNamed(id, text)
}

// What the views need beside the tickets to tell one piece of work from another.
export async function readStoriesAndCheckout($: Engine, location: BoardLocation): Promise<{ stories: Story[]; checkedOutBranch?: string }> {
  const [stories, checkedOutBranch] = await Promise.all([readBoardFolder($, location, STORY_READING), readCheckedOutBranch($, location)])

  return { stories: stories.items, ...(checkedOutBranch === undefined ? {} : { checkedOutBranch }) }
}

// Only a board.json with no usable prefix lists the folders, for the prefix the ids on disk carry.
export async function readBoardConfig($: Engine, location: BoardLocation): Promise<BoardConfig> {
  const config = configIn(await readOptional($, boardPath(location, 'board.json')))
  if (config.prefix !== undefined) return remembered(config)
  const [ticketIds, storyIds] = await Promise.all([markdownIdsIn($, boardPath(location, 'tickets')), markdownIdsIn($, boardPath(location, 'stories'))])

  return remembered(withPrefixFromDisk(config, ticketIds, storyIds))
}

// Said once a session, on the first read that finds it: the board's folder is gone while the exclude line it wrote is
// still there, which is what a git clean -x leaves. Nothing is stored to know it.
export async function readVanishedBoardNotice($: Engine, location: BoardLocation, files: BoardFiles): Promise<string | undefined> {
  if (location.gitCommonDir === undefined || files.configText !== undefined || hasWorkOnDisk(files)) return undefined
  const isFolderThere = await $.fs.list(boardPath(location)).then(
    () => true,
    () => false,
  )

  return isFolderThere ? undefined : excludedBoardNotice($, location.gitCommonDir)
}

async function excludedBoardNotice($: Engine, gitCommonDir: string): Promise<string | undefined> {
  const exclude = await readOptional($, joinPath(gitCommonDir, 'info', 'exclude'))

  return exclude !== undefined && hasExcludeEntry(exclude) ? VANISHED_BOARD_NOTICE : undefined
}

const BRIEF_FOLDER = 'briefs'

export const briefPathOf = (location: BoardLocation, ticketId: string): string => boardPath(location, BRIEF_FOLDER, `${ticketId}.md`)

export type BriefFile = { ticketId: string; text: string }

const BRIEF_FILE_FAILED = 'The brief file could not be written, so neither a wave nor a reviewer can read it by path: make the Agent call as given, and give a reviewer the brief text itself.'

// The folder ignores itself, so a board that a team commits never shows a brief in git status. One file per ticket id,
// overwritten by the next start, so the folder holds at most one file for each ticket on the board.
export async function keepBriefFile($: Engine, location: BoardLocation, brief: BriefFile | undefined): Promise<string[]> {
  if (brief === undefined) return []
  try {
    await $.fs.write(boardPath(location, BRIEF_FOLDER, '.gitignore'), '*\n')
    await $.fs.write(briefPathOf(location, brief.ticketId), brief.text)

    return []
  } catch {
    return [BRIEF_FILE_FAILED]
  }
}

function writeFailure($: Engine, path: string, text: string): Promise<string | undefined> {
  return $.fs.write(path, text).then(
    () => undefined,
    (error: unknown) => failureOf(error),
  )
}

type ExcludedFolder = { folder: string; notice: string }
type GitCheckedFolder = ExcludedFolder & { probeFile: string }

const BOARD_EXCLUSION: GitCheckedFolder = {
  folder: BOARD_FOLDER,
  probeFile: 'board.json',
  notice: 'Added .sidequest/ to .git/info/exclude so the board stays out of git: it is personal, and a team shares work through its tracker.',
}

const WORKTREES_EXCLUSION: ExcludedFolder = {
  folder: '.claude/worktrees',
  notice: 'Added .claude/worktrees/ to .git/info/exclude so the folders agents work in stay out of git status.',
}

const spellingsOf = (exclusion: ExcludedFolder): string[] => {
  const { folder } = exclusion

  return [folder, `${folder}/`, `/${folder}`, `/${folder}/`]
}

const hasExcludeEntry = (exclude: string, exclusion: ExcludedFolder = BOARD_EXCLUSION): boolean =>
  exclude.split('\n').some(line => spellingsOf(exclusion).includes(line.trim()))

const endsWithNewline = (text: string): boolean => text === '' || text.endsWith('\n')

export const withExcludeEntry = (exclude: string, exclusion: ExcludedFolder = BOARD_EXCLUSION): string | undefined => {
  if (hasExcludeEntry(exclude, exclusion)) return undefined

  return `${exclude}${endsWithNewline(exclude) ? '' : '\n'}${exclusion.folder}/\n`
}

function askGit($: Engine, location: BoardLocation, argv: string[]): Promise<ProcessRunResult | undefined> {
  return $.process.run(['git', ...argv], { cwd: location.root }).catch(() => undefined)
}

// Anything git does not answer plainly counts as claimed, so an unclear repository is left as it is.
async function isFolderLeftToGit($: Engine, location: BoardLocation, exclusion: GitCheckedFolder): Promise<boolean> {
  const tracked = await askGit($, location, ['ls-files', '--', exclusion.folder])
  if (tracked?.exitCode !== 0 || tracked.stdout.trim() !== '') return true
  const ignored = await askGit($, location, ['check-ignore', '-q', `${exclusion.folder}/${exclusion.probeFile}`])

  return ignored?.exitCode !== 1
}

// The exclude file is read first, so a repository that already lists the folder starts no process.
async function excludeFolderFromGit($: Engine, location: BoardLocation, exclusion: GitCheckedFolder): Promise<string | undefined> {
  if (location.gitCommonDir === undefined) return undefined
  const path = joinPath(location.gitCommonDir, 'info', 'exclude')
  const updated = withExcludeEntry((await readOptional($, path)) ?? '', exclusion)
  if (updated === undefined || (await isFolderLeftToGit($, location, exclusion))) return undefined
  await $.fs.write(path, updated)

  return exclusion.notice
}

function excludeBoardFromGit($: Engine, location: BoardLocation): Promise<string | undefined> {
  return excludeFolderFromGit($, location, BOARD_EXCLUSION)
}

// Git is not asked here, so a start on fresh work still starts no process: the exclude file and the root .gitignore
// are read as text. A .gitignore that covers the folder some other way costs one spare line in a personal file.
async function excludeWorktreesByReadingFiles($: Engine, location: BoardLocation): Promise<string | undefined> {
  if (location.gitCommonDir === undefined) return undefined
  const path = joinPath(location.gitCommonDir, 'info', 'exclude')
  const updated = withExcludeEntry((await readOptional($, path)) ?? '', WORKTREES_EXCLUSION)
  if (updated === undefined) return undefined
  const gitignore = (await readOptional($, joinPath(location.root, '.gitignore'))) ?? ''
  if (hasExcludeEntry(gitignore, WORKTREES_EXCLUSION)) return undefined
  await $.fs.write(path, updated)

  return WORKTREES_EXCLUSION.notice
}

// The folder agents' worktrees go in is a nested checkout, so a git add -A would stage it. Never throws.
export function excludeWorktreesFromGit($: Engine, location: BoardLocation): Promise<string | undefined> {
  return excludeWorktreesByReadingFiles($, location).catch(() => undefined)
}

const noRepositoryNotice = (location: BoardLocation): string =>
  `Created the board at ${boardPath(location)}. This folder is not a git repository.`

function noticeForNewBoard($: Engine, location: BoardLocation): Promise<string | undefined> {
  if (location.gitCommonDir === undefined) return Promise.resolve(noRepositoryNotice(location))

  return excludeBoardFromGit($, location).catch(() => undefined)
}

const prefixPart = (config: BoardConfig): { prefix?: string } => (config.prefix === undefined ? {} : { prefix: config.prefix })

const counterIn = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) ? value : 0)


// Only the prefix and the counters change, so a hand-edited board.json keeps every key and value this version does not
// know, and a board from before prefixes is never given one. A counter another session moved on is never taken back.
const boardJsonAfter = (existing: string | undefined, config: BoardConfig): Record<string, unknown> | undefined => {
  if (isBlank(existing)) return config
  const parsed = parseJson(existing ?? '')

  return isRecord(parsed)
    ? { ...parsed, ...prefixPart(config), nextTicket: Math.max(counterIn(parsed.nextTicket), config.nextTicket), nextStory: Math.max(counterIn(parsed.nextStory), config.nextStory) }
    : undefined
}

type ConfigSaved = { newBoardNotice?: string; notes: string[] }

const NOTHING_SAID: ConfigSaved = { notes: [] }

// The one-time notice goes with the write that created the board: the exclude line it added, or that the folder is no
// repository. A board that can't be excluded is still written. A board.json put back beside tickets says so instead.
async function noticesAfterConfigWrite($: Engine, location: BoardLocation, existing: string | undefined, read: BoardRead, config: BoardConfig): Promise<ConfigSaved> {
  if (!isBlank(existing)) return NOTHING_SAID
  if (hasWorkOnDisk(read.files)) return { notes: [boardJsonWrittenAgainNotice(config.prefix)] }
  const newBoardNotice = await noticeForNewBoard($, location)

  return newBoardNotice === undefined ? NOTHING_SAID : { newBoardNotice, notes: [] }
}

// Read again right before the write, so a counter is the larger of what is on disk now and what this call has.
async function writeBoardConfig($: Engine, location: BoardLocation, read: BoardRead, config: BoardConfig): Promise<ConfigSaved> {
  const path = boardPath(location, 'board.json')
  const existing = await readOptional($, path)
  const written = boardJsonAfter(existing, config)
  const failure = written === undefined ? undefined : await writeFailure($, path, serializeBoardConfig(written))
  if (failure !== undefined) return { notes: [`.sidequest/board.json could not be written (${failure}), so its counters stay as they were.`] }

  return noticesAfterConfigWrite($, location, existing, read, config)
}

const hasEarlierWork = (config: BoardConfig, idsOnFile: number): boolean =>
  idsOnFile > 0 || config.nextTicket > 1 || config.nextStory > 1

// A bare repository's folder is named x.git, and the prefix comes from the project's name, not git's.
const folderNameOf = (root: string): string => projectNameOf(root) ?? root

const idsTheFirstWriteWouldTake = (location: BoardLocation, checkedOutBranch: string | undefined): BoardIds =>
  boardIdsOf(choosePrefix(prefixFactsFrom(folderNameOf(location.root), [checkedOutBranch ?? ''])).prefix)

// For the examples in the tool descriptions only, so a new board reads no branch list: its first write still checks them.
export async function readIdsToDescribe($: Engine, location: BoardLocation): Promise<BoardIds> {
  const config = await readBoardConfig($, location)
  if (config.prefix !== undefined) return boardIdsOf(config.prefix)
  const [ticketIds, storyIds, checkedOutBranch] = await Promise.all([
    markdownIdsIn($, boardPath(location, 'tickets')),
    markdownIdsIn($, boardPath(location, 'stories')),
    readCheckedOutBranch($, location),
  ])

  return hasEarlierWork(config, ticketIds.length + storyIds.length) ? EARLIER_BOARD_IDS : idsTheFirstWriteWouldTake(location, checkedOutBranch)
}

async function readBranchNames($: Engine, location: BoardLocation): Promise<string[]> {
  if (location.gitCommonDir === undefined) return []
  const answer = await askGit($, location, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])

  return answer?.exitCode === 0 ? answer.stdout.split('\n').filter(line => line.trim() !== '') : []
}

// Read only while a board has no prefix and nothing on it, so a board pays for this git call once in its life. A board
// that had tickets before prefixes existed gets none, and keeps SQ and ST.
export async function readPrefixFacts($: Engine, location: BoardLocation, files: BoardFiles): Promise<PrefixFacts | undefined> {
  if (files.config.prefix !== undefined || hasWorkOnDisk(files) || hasEarlierWork(files.config, 0)) return undefined
  const branchNames = await readBranchNames($, location)

  return prefixFactsFrom(folderNameOf(location.root), [...branchNames, files.checkedOutBranch ?? ''])
}

// What a write put on disk: the tickets and stories as written, under the ids they were filed as, and what its answer
// has to add. A new board's exclude notice stands on its own line, as it always did.
// `notWritten` holds the tickets that changed on disk again while the call was redone, which were left alone.
export type SavedChange = {
  tickets: Ticket[]
  stories: Story[]
  renamedIds: ReadonlyMap<string, string>
  newBoardNotice?: string
  notes: string[]
  notWritten: string[]
}

const NOTHING_SAVED: SavedChange = { tickets: [], stories: [], renamedIds: new Map(), notes: [], notWritten: [] }

export type BoardDecision = { change?: BoardChange }

export type DecidedWrite<Decision> = { files: BoardFiles; decision: Decision; saved: SavedChange }

type Settled<Decision> = { read: BoardRead; decision: Decision; changedTwice: string[] }

async function ticketsChangedOnDisk($: Engine, location: BoardLocation, read: BoardRead, change: BoardChange | undefined): Promise<string[]> {
  const known = (change?.tickets ?? []).filter(ticket => read.ticketTexts.has(ticket.id))
  const nowOnDisk = await Promise.all(known.map(ticket => readOptional($, ticketPath(location, ticket.id))))

  return known.filter((ticket, index) => nowOnDisk[index] !== read.ticketTexts.get(ticket.id)).map(ticket => ticket.id)
}

// Seen on 2026-11-20: lines a person appended to a ticket between a write's read and its write were gone, 3 of 3
// times. So each ticket is read again right before the write; a changed one has the whole call redone once on the new
// text, and one that changed again by then is left alone.
async function settledDecision<Decision extends BoardDecision>(
  $: Engine,
  location: BoardLocation,
  decide: (files: BoardFiles) => Decision | Promise<Decision>,
  firstRead: BoardRead | undefined,
): Promise<Settled<Decision>> {
  const read = firstRead ?? (await readBoardAndTexts($, location))
  const decision = await decide(read.files)
  if ((await ticketsChangedOnDisk($, location, read, decision.change)).length === 0) return { read, decision, changedTwice: [] }
  const reread = await readBoardAndTexts($, location)
  const redone = await decide(reread.files)

  return { read: reread, decision: redone, changedTwice: await ticketsChangedOnDisk($, location, reread, redone.change) }
}

type FilingForm<Item> = { folder: BoardFolder; serialize: (item: Item) => string; withRenamedReferences: (item: Item, renamed: ReadonlyMap<string, string>) => Item }

const TICKET_FILING: FilingForm<Ticket> = { folder: 'tickets', serialize: serializeTicket, withRenamedReferences: ticketWithRenamedReferences }

const STORY_FILING: FilingForm<Story> = { folder: 'stories', serialize: serializeStory, withRenamedReferences: story => story }

type Filed<Item> = { items: Item[]; notes: string[] }

type FiledOne<Item> = { item?: Item; note?: string }

// Another session filing its own ticket under the same name can land after this write, so what is on disk is read back.
async function isKeptAfterWrite($: Engine, path: string, text: string): Promise<{ isKept: boolean; failure?: string }> {
  const failure = await writeFailure($, path, text)
  if (failure !== undefined) return { isKept: false, failure }

  return { isKept: (await readOptional($, path)) === text }
}

const FILING_ATTEMPTS = 3

const keptNote = (decided: string, filed: string): string | undefined => (decided === filed ? undefined : filedUnderAnotherIdNote(decided, filed))

async function fileNewItem<Item extends { id: string }>($: Engine, location: BoardLocation, form: FilingForm<Item>, item: Item, taken: Set<string>): Promise<FiledOne<Item>> {
  let id = freeIdFrom(item.id, taken)
  for (let attempt = 1; attempt <= FILING_ATTEMPTS; attempt += 1) {
    taken.add(id.toLowerCase())
    const filing: Item = { ...item, id }
    const outcome = await isKeptAfterWrite($, boardPath(location, form.folder, `${id}.md`), form.serialize(filing))
    if (outcome.isKept) return { item: filing, note: keptNote(item.id, id) }
    if (outcome.failure !== undefined) return { note: notFiledNote(form.folder, id, outcome.failure) }
    id = freeIdFrom(id, taken)
  }

  return { note: notFiledAfterTriesNote(item.id) }
}

const addFiled = <Item extends { id: string }>(filed: Filed<Item>, one: FiledOne<Item>, decidedId: string, renamed: Map<string, string>): void => {
  if (one.item !== undefined) filed.items.push(one.item)
  if (one.item !== undefined && one.item.id !== decidedId) renamed.set(decidedId, one.item.id)
  if (one.note !== undefined) filed.notes.push(one.note)
}

// Seen on 2026-11-20: two sessions creating at the same moment took the same id in 2 of 10 tries, and one ticket was
// gone. The host has no exclusive create, so the number comes from a fresh look at the folder right before the write.
async function fileNewItems<Item extends { id: string }>(
  $: Engine,
  location: BoardLocation,
  form: FilingForm<Item>,
  items: readonly Item[],
  renamed: Map<string, string>,
): Promise<Filed<Item>> {
  const filed: Filed<Item> = { items: [], notes: [] }
  if (items.length === 0) return filed
  const taken = new Set((await markdownIdsIn($, boardPath(location, form.folder))).map(name => name.toLowerCase()))
  for (const item of items) addFiled(filed, await fileNewItem($, location, form, form.withRenamedReferences(item, renamed), taken), item.id, renamed)

  return filed
}

async function writeKnownItems<Item extends { id: string }>(
  $: Engine,
  location: BoardLocation,
  form: FilingForm<Item>,
  items: readonly Item[],
  renamed: ReadonlyMap<string, string>,
): Promise<Filed<Item>> {
  const written = items.map(item => form.withRenamedReferences(item, renamed))
  const failures = await Promise.all(written.map(item => writeFailure($, boardPath(location, form.folder, `${item.id}.md`), form.serialize(item))))

  return {
    items: written.filter((item, index) => failures[index] === undefined),
    notes: written.flatMap((item, index) => {
      const failure = failures[index]

      return failure === undefined ? [] : [notWrittenNote(form.folder, item.id, failure)]
    }),
  }
}

const countersAfter = (config: BoardConfig, files: BoardFiles, tickets: readonly Ticket[], stories: readonly Story[]): BoardConfig => ({
  ...config,
  nextTicket: nextNumberAfter(config.nextTicket, [...(files.idsOnDisk?.tickets ?? []), ...tickets.map(ticket => ticket.id)]),
  nextStory: nextNumberAfter(config.nextStory, [...(files.idsOnDisk?.stories ?? []), ...stories.map(story => story.id)]),
})

// Written after the tickets, so a counter never names a ticket that is not on disk. A board.json that went missing
// beside tickets is put back by the next write that gives out an id.
function saveCounters($: Engine, location: BoardLocation, read: BoardRead, change: BoardChange, filed: { tickets: Ticket[]; stories: Story[] }): Promise<ConfigSaved> {
  if (change.config === undefined) return Promise.resolve(NOTHING_SAID)

  return writeBoardConfig($, location, read, countersAfter(change.config, read.files, filed.tickets, filed.stories))
}

async function saveSettledChange($: Engine, location: BoardLocation, settled: Settled<BoardDecision>, change: BoardChange): Promise<SavedChange> {
  const { read, changedTwice } = settled
  const isKnownStory = (story: Story): boolean => read.files.stories.some(one => one.id === story.id)
  const isKnownTicket = (ticket: Ticket): boolean => read.ticketTexts.has(ticket.id)
  const renamed = new Map<string, string>()
  const newStories = await fileNewItems($, location, STORY_FILING, change.stories.filter(story => !isKnownStory(story)), renamed)
  const newTickets = await fileNewItems($, location, TICKET_FILING, change.tickets.filter(ticket => !isKnownTicket(ticket)), renamed)
  const knownTickets = change.tickets.filter(ticket => isKnownTicket(ticket) && !changedTwice.includes(ticket.id))
  const [tickets, stories] = await Promise.all([
    writeKnownItems($, location, TICKET_FILING, knownTickets, renamed),
    writeKnownItems($, location, STORY_FILING, change.stories.filter(isKnownStory), renamed),
  ])
  const filed = { tickets: [...newTickets.items, ...tickets.items], stories: [...newStories.items, ...stories.items] }
  const config = await saveCounters($, location, read, change, filed)
  const notes = [...changedTwice.map(changedOnDiskNote), ...newStories.notes, ...newTickets.notes, ...tickets.notes, ...stories.notes, ...config.notes]

  return { ...filed, renamedIds: renamed, notes, notWritten: changedTwice, ...(config.newBoardNotice === undefined ? {} : { newBoardNotice: config.newBoardNotice }) }
}

// Every write to the board goes through here: read, decide, check the tickets it changes are still as read, then write
// new files under free names, the changed ones, and board.json last. A caller that already read the board inside the
// write queue hands that read in, and the check against the disk is the same.
export async function writeBoardDecision<Decision extends BoardDecision>(
  $: Engine,
  location: BoardLocation,
  decide: (files: BoardFiles) => Decision | Promise<Decision>,
  firstRead?: BoardRead,
): Promise<DecidedWrite<Decision>> {
  const settled = await settledDecision($, location, decide, firstRead)
  const change = settled.decision.change
  const saved = change === undefined ? NOTHING_SAVED : await saveSettledChange($, location, settled, change)

  return { files: settled.read.files, decision: settled.decision, saved }
}

// One ticket, read and written on its own for a line on its log, with the same check as a board write.
export async function changeTicketFile($: Engine, location: BoardLocation, id: string, change: (ticket: Ticket) => Ticket): Promise<void> {
  const read = await readTicketFile($, location, id)
  if (read !== undefined) await writeWhenUnchanged($, location, read, change, 1)
}

async function writeWhenUnchanged($: Engine, location: BoardLocation, read: TicketRead, change: (ticket: Ticket) => Ticket, redosLeft: number): Promise<void> {
  const changed = change(read.ticket)
  const now = await readTicketFile($, location, read.ticket.id)
  if (now?.text === read.text) await writeFailure($, ticketPath(location, changed.id), serializeTicket(changed))
  else if (now !== undefined && redosLeft > 0) await writeWhenUnchanged($, location, now, change, redosLeft - 1)
}

// A provider file written before CLAUDE_CONFIG_DIR was honoured sits under the home folder's .claude, so it is the fallback.
async function providerFolders($: Engine): Promise<string[]> {
  const [CLAUDE_CONFIG_DIR, HOME, USERPROFILE] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')])
  const folders = [configDirectoryOf({ CLAUDE_CONFIG_DIR, HOME, USERPROFILE }), configDirectoryOf({ HOME, USERPROFILE })]
  const known = folders.filter((folder): folder is string => folder !== undefined)

  return [...new Set(known)].map(folder => joinPath(folder, 'toolshed', 'providers'))
}

async function providerFileNames($: Engine, folder: string): Promise<string[]> {
  const entries = await $.fs.list(folder).catch(() => [])

  return entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).map(entry => entry.name).sort()
}

export async function readConfigFolder($: Engine): Promise<string | undefined> {
  const [CLAUDE_CONFIG_DIR, HOME, USERPROFILE] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME'), $.env.get('USERPROFILE')])

  return configDirectoryOf({ CLAUDE_CONFIG_DIR, HOME, USERPROFILE })
}

export async function readInstalledPluginsRecord($: Engine): Promise<string | undefined> {
  const configFolder = await readConfigFolder($)

  return configFolder === undefined ? undefined : readOptional($, joinPath(configFolder, 'plugins', 'installed_plugins.json'))
}

export async function readProviders($: Engine): Promise<Providers> {
  for (const folder of await providerFolders($)) {
    const names = await providerFileNames($, folder)
    if (names.length === 0) continue
    const texts = await Promise.all(names.map(name => readOptional($, joinPath(folder, name))))

    return providersOf(texts.flatMap(text => (text === undefined ? [] : [parseJson(text)])))
  }

  return NO_PROVIDERS
}
