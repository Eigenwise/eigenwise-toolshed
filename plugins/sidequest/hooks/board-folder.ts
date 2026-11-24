import { idNumber, parseStory, parseTicket } from './tickets'
import type { Story, Ticket } from './tickets'

export type BoardFolder = 'tickets' | 'stories'

// A file in a board folder that is never read as a ticket or story and never written: one whose read failed, one with
// no id or no status, and a stray whose name is not the id it claims (a sync tool's or a file manager's copy).
export type UnusableFile = {
  folder: BoardFolder
  name: string
  trouble: 'unreadable' | 'damaged' | 'stray'
  claimedId?: string
  cause?: string
}

export type FileRead = { name: string; text: string } | { name: string; failure: string }

export type FolderContents<Item> = {
  items: Item[]
  texts: Map<string, string>
  unusable: UnusableFile[]
  // Every id a file in the folder carries by its name or claims, read or not, so a new id never lands on one.
  idsOnDisk: string[]
}

export type ItemReading<Item> ={ folder: BoardFolder; parse: (text: string) => Item; isWhole: (item: Item) => boolean }

export const TICKET_READING: ItemReading<Ticket> = {
  folder: 'tickets',
  parse: text => parseTicket(text),
  isWhole: ticket => ticket.id !== '' && ticket.status !== '',
}

export const STORY_READING: ItemReading<Story> = {
  folder: 'stories',
  parse: text => parseStory(text),
  isWhole: story => story.id !== '',
}

export const boardFilePath = (folder: BoardFolder, name: string): string => `.sidequest/${folder}/${name}.md`

type Sorted<Item> = { item?: Item; text?: string; unusable?: UnusableFile; idOnDisk?: string }

// A file that went between the listing and the read is simply gone, so only another failure makes it unreadable.
const sortedFailure = <Item>(folder: BoardFolder, name: string, failure: string): Sorted<Item> =>
  failure.includes('ENOENT') ? {} : { unusable: { folder, name, trouble: 'unreadable', cause: failure }, idOnDisk: name }

const sortedText = <Item extends { id: string }>(reading: ItemReading<Item>, name: string, text: string): Sorted<Item> => {
  const item = reading.parse(text)
  if (!reading.isWhole(item)) return { unusable: { folder: reading.folder, name, trouble: 'damaged' }, idOnDisk: name }
  if (item.id !== name) return { unusable: { folder: reading.folder, name, trouble: 'stray', claimedId: item.id }, idOnDisk: item.id }

  return { item, text, idOnDisk: name }
}

const sortedFile = <Item extends { id: string }>(reading: ItemReading<Item>, file: FileRead): Sorted<Item> =>
  'failure' in file ? sortedFailure(reading.folder, file.name, file.failure) : sortedText(reading, file.name, file.text)

const addSorted = <Item extends { id: string }>(contents: FolderContents<Item>, sorted: Sorted<Item>): void => {
  if (sorted.item !== undefined && sorted.text !== undefined) {
    contents.items.push(sorted.item)
    contents.texts.set(sorted.item.id, sorted.text)
  }
  if (sorted.unusable !== undefined) contents.unusable.push(sorted.unusable)
  if (sorted.idOnDisk !== undefined) contents.idsOnDisk.push(sorted.idOnDisk)
}

export const folderContentsOf = <Item extends { id: string }>(reading: ItemReading<Item>, files: readonly FileRead[]): FolderContents<Item> => {
  const contents: FolderContents<Item> = { items: [], texts: new Map(), unusable: [], idsOnDisk: [] }
  for (const file of files) addSorted(contents, sortedFile(reading, file))

  return contents
}

// The single file named after an id, read on its own: it is that ticket only when it is whole and claims that id.
export const ticketNamed = (id: string, text: string): Ticket | undefined => {
  const ticket = TICKET_READING.parse(text)

  return TICKET_READING.isWhole(ticket) && ticket.id === id ? ticket : undefined
}

export const storyNamed = (id: string, text: string): Story | undefined => {
  const story = STORY_READING.parse(text)

  return STORY_READING.isWhole(story) && story.id === id ? story : undefined
}

const strayWords = (file: UnusableFile): string => `${boardFilePath(file.folder, file.name)} claims ${file.claimedId ?? 'no id'}`

const strayLine = (strays: readonly UnusableFile[]): string[] =>
  strays.length === 0
    ? []
    : [`Stray files, never read as a ticket or story and never written: ${strays.map(strayWords).join(', ')}. Only the file named after its own id is read. Merge what you need into it by hand and remove the copy.`]

const missingParts = (folder: BoardFolder): string => (folder === 'tickets' ? 'no id or no status' : 'no id')

const troubleLine = (file: UnusableFile): string => {
  const path = boardFilePath(file.folder, file.name)

  return file.trouble === 'unreadable'
    ? `${path} could not be read (${file.cause ?? 'no reason given'}), so ${file.name} is left out and nothing writes to it until it can be read.`
    : `${path} is damaged (it has ${missingParts(file.folder)}), so ${file.name} is left out and nothing writes to it. Fix it by hand; its number stays taken.`
}

export const unusableFileLines = (unusable: readonly UnusableFile[] | undefined, folder?: BoardFolder): string[] => {
  const inFolder = (unusable ?? []).filter(file => folder === undefined || file.folder === folder)

  return [...strayLine(inFolder.filter(file => file.trouble === 'stray')), ...inFolder.filter(file => file.trouble !== 'stray').map(troubleLine)]
}

// The id itself when no file in the folder has its name, else the next number up that none has. `taken` holds the
// names in lower case, since a case-insensitive disk keeps one file for both spellings.
export const freeIdFrom = (id: string, taken: ReadonlySet<string>): string => {
  const letters = id.replace(/\d+$/, '')
  let number = idNumber(id)
  while (taken.has(`${letters}${number}`.toLowerCase())) number += 1

  return `${letters}${number}`
}

const renamedOr = (renamed: ReadonlyMap<string, string>, id: string): string => renamed.get(id) ?? id

export const ticketWithRenamedReferences = (ticket: Ticket, renamed: ReadonlyMap<string, string>): Ticket => ({
  ...ticket,
  blockedBy: ticket.blockedBy.map(id => renamedOr(renamed, id)),
  ...(ticket.story === undefined ? {} : { story: renamedOr(renamed, ticket.story) }),
})

export const filedUnderAnotherIdNote = (decided: string, filed: string): string =>
  `${decided} was filed by another session at the same moment, so the one created here is ${filed}. Use ${filed} from now on.`

export const notFiledNote = (folder: BoardFolder, id: string, failure: string): string =>
  `${boardFilePath(folder, id)} could not be written (${failure}), so ${id} was not created.`

export const notFiledAfterTriesNote = (id: string): string =>
  `${id} was not created: each number tried was taken by another write at the same moment. Create it again.`

export const notWrittenNote = (folder: BoardFolder, id: string, failure: string): string =>
  `${boardFilePath(folder, id)} could not be written (${failure}), so the change to ${id} is not on the board.`

export const changedOnDiskNote = (id: string): string =>
  `${id} changed on disk while this call wrote it, and again after the change was redone on the new text, so nothing was written to ${id}. Read it again and repeat the change.`

// What a write that names such a file says instead of claiming the ticket is not on the board.
export const unusableFileProblem = (unusable: readonly UnusableFile[] | undefined, id: string): string | undefined => {
  const file = (unusable ?? []).find(candidate => candidate.name === id && candidate.trouble !== 'stray')

  return file === undefined ? undefined : `${id}: ${troubleLine(file)}`
}
