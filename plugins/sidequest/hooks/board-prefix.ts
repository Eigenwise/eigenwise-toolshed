import type { BoardConfig } from './board-config'
import { boardIdsOf, storyIdOn, ticketIdOn } from './board-ids'
import { trackerKeysInBranch } from './branch-and-issue'

// What a board with no prefix yet knows when its first id is given out: the project's folder name, and every tracker
// key seen in its branch names and in the call that files the work.
export type PrefixFacts = { folderName: string; trackerKeys: readonly string[] }

type PassedOver = { prefix: string; key: string }

export type PrefixChoice = { prefix: string; folderName: string; passedOver: readonly PassedOver[] }

const SHORTEST = 2
const LONGEST = 4
const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const WHEN_THE_NAME_HAS_NO_LETTERS = 'SQ'

const wordsOf = (folderName: string): string[] =>
  folderName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(word => word !== '')
    .map(word => word.toUpperCase())

const initialsOf = (words: readonly string[]): string =>
  words
    .slice(0, LONGEST)
    .map(word => word.charAt(0))
    .join('')

const shortFormOfOneWord = (word: string): string => (word.length <= LONGEST ? word : word.slice(0, 3))

const firstChoiceFor = (words: readonly string[]): string => (words.length > 1 ? initialsOf(words) : shortFormOfOneWord(words[0] ?? ''))

const isUsableLength = (prefix: string): boolean => prefix.length >= SHORTEST && prefix.length <= LONGEST

// In the order they are tried: the short form a person would read first, then the name's own start, then its first
// letter with each later letter, then with any letter, so a free one is always left.
export const prefixCandidatesFor = (folderName: string): string[] => {
  const words = wordsOf(folderName)
  const letters = words.join('') || WHEN_THE_NAME_HAS_NO_LETTERS
  const first = letters.charAt(0)
  const candidates = [
    firstChoiceFor(words),
    letters.slice(0, 2),
    letters.slice(0, 3),
    letters.slice(0, LONGEST),
    ...[...letters.slice(1)].map(letter => `${first}${letter}`),
    ...ALPHABET.map(letter => `${first}${letter}`),
  ]

  return [...new Set(candidates.filter(isUsableLength))]
}

const prefixOfKey = (key: string): string => key.slice(0, key.indexOf('-'))

export const choosePrefix = (facts: PrefixFacts): PrefixChoice => {
  // Built from the end, so the key named for a prefix is the first one seen.
  const keyByPrefix = new Map([...facts.trackerKeys].reverse().map(key => [prefixOfKey(key), key]))
  const candidates = prefixCandidatesFor(facts.folderName)
  const chosenAt = Math.max(0, candidates.findIndex(candidate => !keyByPrefix.has(candidate)))
  const passedOver = candidates.slice(0, chosenAt).map(prefix => ({ prefix, key: keyByPrefix.get(prefix) ?? prefix }))

  return { prefix: candidates[chosenAt] ?? WHEN_THE_NAME_HAS_NO_LETTERS, folderName: facts.folderName, passedOver }
}

export const prefixFactsFrom = (folderName: string, branchNames: readonly string[]): PrefixFacts => ({
  folderName,
  trackerKeys: branchNames.flatMap(trackerKeysInBranch),
})

export const withMoreTrackerKeys = (facts: PrefixFacts, keys: readonly string[]): PrefixFacts => ({
  ...facts,
  trackerKeys: [...facts.trackerKeys, ...keys],
})

const TICKET_ID_LETTERS = /^([A-Z]{1,10})-\d+$/
const STORY_ID_LETTERS = /^([A-Z]{1,10})-S\d+$/

const lettersOf = (pattern: RegExp, ids: readonly string[]): string[] => ids.flatMap(id => pattern.exec(id)?.[1] ?? [])

const mostCommonOf = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)

  // The sort keeps the order of a tie, so the prefix seen first wins it.
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
}

const EARLIER_TICKET_LETTERS = 'SQ'

// Seen on 2026-11-20: with board.json gone, a board of SA-1 to SA-5 gave out SQ-6. The ids on disk still say which
// prefix the board has. SQ is the prefix of a board from before prefixes, which keeps SQ and ST and never gets one.
export const prefixCarriedBy = (ticketIds: readonly string[], storyIds: readonly string[]): string | undefined => {
  const prefix = mostCommonOf([...lettersOf(TICKET_ID_LETTERS, ticketIds), ...lettersOf(STORY_ID_LETTERS, storyIds)])

  return prefix === EARLIER_TICKET_LETTERS ? undefined : prefix
}

export const withPrefixFromDisk = (config: BoardConfig, ticketIds: readonly string[], storyIds: readonly string[]): BoardConfig => {
  const prefix = config.prefix ?? prefixCarriedBy(ticketIds, storyIds)

  return prefix === undefined ? config : { ...config, prefix }
}

const passedOverWords =(passedOver: readonly PassedOver[]): string =>
  passedOver.length === 0
    ? ''
    : ` ${passedOver.map(({ prefix, key }) => `${prefix} was passed over because the tracker key ${key} uses it`).join(', ')}, so a board id never reads as a tracker issue.`

export const prefixChoiceNote = (choice: PrefixChoice): string => {
  const ids = boardIdsOf(choice.prefix)
  const numbering = `This board numbers its tickets ${ticketIdOn(ids, 1)}, ${ticketIdOn(ids, 2)} and on, and its stories ${storyIdOn(ids, 1)} and on: ${choice.prefix} comes from the folder name ${choice.folderName}.`

  return `${numbering}${passedOverWords(choice.passedOver)} The prefix is kept as "prefix" in .sidequest/board.json. To use other letters, change it there now, before there are many tickets.`
}
