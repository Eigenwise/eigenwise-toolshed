export type Tier = { model: string; effort: string; fallback?: string }
const AGENT_ROLES = ['worker', 'scout', 'outside-code-reviewer'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]
export type Category = { tier: string; role: AgentRole; description: string }
// `refresh` says how the running thing picks up new code: `auto` (it reloads by itself), `ask` (the person restarts
// it), or a command.
export type SharedThing = { what: string; refresh: string }
export type BeforeBuilding = { label: string; how: string; readBack?: string }
export type BoardSettings = {
  verify: string
  planReviewPasses: number
  worktrees: boolean
  unrouted: string
  // Absent on a board with nothing shared, so such a board reads and writes exactly as before shared things existed.
  shared?: Record<string, SharedThing>
  // Free text: what the checks need, where they can run, the command that works. Absent when nobody wrote it down.
  checks?: string
  // A step between agreed and build, in the team's own words. Absent when the project has none.
  beforeBuilding?: BeforeBuilding
  // Whether pull requests here carry a diagram of the change. Absent until the person was asked.
  pullRequestDiagram?: boolean
}

export type BoardConfig = {
  version: 1
  // The letters every id on this board starts with, chosen when the first id is given out. A board that had tickets
  // before prefixes existed never gets one and keeps SQ and ST.
  prefix?: string
  nextTicket: number
  nextStory: number
  tiers: Record<string, Tier>
  categories: Record<string, Category>
  settings: BoardSettings
}

export const DEFAULT_BOARD_CONFIG: BoardConfig = {
  version: 1,
  nextTicket: 1,
  nextStory: 1,
  tiers: {
    light: { model: 'sonnet', effort: 'low' },
    standard: { model: 'sonnet', effort: 'medium' },
    deep: { model: 'opus', effort: 'high' },
    top: { model: 'fable', effort: 'high' },
  },
  categories: {
    explore: { tier: 'light', role: 'scout', description: 'Find and explain how existing code works.' },
    research: { tier: 'deep', role: 'scout', description: 'Real digging: a reproduction, a measurement, or research outside the code.' },
    quick: { tier: 'light', role: 'worker', description: 'Small change at a known location.' },
    build: { tier: 'standard', role: 'worker', description: 'Ordinary feature or fix. The default.' },
    hard: { tier: 'deep', role: 'worker', description: 'Design-heavy or cross-cutting change.' },
    debug: { tier: 'deep', role: 'worker', description: 'Find the root cause of a failure, then fix it.' },
    review: { tier: 'deep', role: 'scout', description: 'Independent review of finished work.' },
    // Its own role, because only an agent type with no shell can be trusted not to run what it reads.
    'outside-code': {
      tier: 'deep',
      role: 'outside-code-reviewer',
      description: 'Security pass before code runs that comes from outside the team, or touches dependencies, build, install or CI.',
    },
  },
  settings: { verify: '', planReviewPasses: 1, worktrees: true, unrouted: 'build' },
}

export const TURNS_OFF_UNROUTED = 'inherit'

type JsonRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAgentRole = (value: unknown): value is AgentRole => AGENT_ROLES.some(role => role === value)

const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)
const booleanOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

// A person who edits it by hand may write it in small letters; anything but letters is not a prefix.
const prefixFrom = (value: unknown): { prefix?: string } => {
  const written = typeof value === 'string' ? value.trim() : ''

  return /^[A-Za-z]{1,10}$/.test(written) ? { prefix: written.toUpperCase() } : {}
}

const counterOr = (value: unknown, fallback: number): number =>
  Number.isInteger(value) && numberOr(value, 0) > 0 ? numberOr(value, fallback) : fallback

const tierFrom = (value: unknown): Tier | undefined => {
  if (!isRecord(value) || typeof value.model !== 'string' || typeof value.effort !== 'string') return undefined
  const fallback = typeof value.fallback === 'string' ? { fallback: value.fallback } : {}

  return { model: value.model, effort: value.effort, ...fallback }
}

const categoryFrom = (value: unknown): Category | undefined => {
  if (!isRecord(value) || typeof value.tier !== 'string') return undefined

  return {
    tier: value.tier,
    role: isAgentRole(value.role) ? value.role : 'worker',
    description: stringOr(value.description, ''),
  }
}

const entriesFrom = <T>(value: unknown, read: (entry: unknown) => T | undefined): Record<string, T> => {
  const entries: Record<string, T> = {}
  for (const [name, entry] of Object.entries(isRecord(value) ? value : {})) {
    const parsed = read(entry)
    if (parsed !== undefined) entries[name] = parsed
  }

  return entries
}

const REFRESH_BY_THE_PERSON = 'ask'

const isOptionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'

const sharedThingFrom = (value: unknown): SharedThing | undefined => {
  if (!isRecord(value) || typeof value.what !== 'string' || !isOptionalText(value.refresh)) return undefined

  return { what: value.what, refresh: stringOr(value.refresh, REFRESH_BY_THE_PERSON) }
}

const sharedFrom = (value: unknown): { shared?: Record<string, SharedThing> } => {
  const shared = entriesFrom(value, sharedThingFrom)

  return Object.keys(shared).length === 0 ? {} : { shared }
}

const checksFrom = (value: unknown): { checks?: string } =>
  typeof value === 'string' && value.trim() !== '' ? { checks: value.trim() } : {}

const textOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const beforeBuildingFrom = (value: unknown): BeforeBuilding | undefined => {
  const step = isRecord(value) ? value : {}
  const label = textOrUndefined(step.label)
  const how = textOrUndefined(step.how)
  const readBack = textOrUndefined(step.readBack)

  return label === undefined || how === undefined ? undefined : { label, how, ...(readBack === undefined ? {} : { readBack }) }
}

const beforeBuildingSetting = (value: unknown): { beforeBuilding?: BeforeBuilding } => {
  const beforeBuilding = beforeBuildingFrom(value)

  return beforeBuilding === undefined ? {} : { beforeBuilding }
}

// The skill was called intake when older boards were written, and a board.json is never rewritten for a rename.
const NAME_BEFORE_THE_PLAN_SKILL = 'intakeReviewPasses'

const planReviewPassesFrom = (settings: JsonRecord, fallback: number): number =>
  numberOr(settings.planReviewPasses, numberOr(settings[NAME_BEFORE_THE_PLAN_SKILL], fallback))

const settingsFrom = (value: unknown): BoardSettings => {
  const settings = isRecord(value) ? value : {}
  const defaults = DEFAULT_BOARD_CONFIG.settings

  return {
    verify: stringOr(settings.verify, defaults.verify),
    planReviewPasses: planReviewPassesFrom(settings, defaults.planReviewPasses),
    worktrees: booleanOr(settings.worktrees, defaults.worktrees),
    unrouted: stringOr(settings.unrouted, defaults.unrouted),
    ...sharedFrom(settings.shared),
    ...checksFrom(settings.checks),
    ...beforeBuildingSetting(settings.beforeBuilding),
    ...(typeof settings.pullRequestDiagram === 'boolean' ? { pullRequestDiagram: settings.pullRequestDiagram } : {}),
  }
}

export const mergeBoardConfig = (partial: unknown): BoardConfig => {
  const board = isRecord(partial) ? partial : {}

  return {
    version: 1,
    ...prefixFrom(board.prefix),
    nextTicket: counterOr(board.nextTicket, DEFAULT_BOARD_CONFIG.nextTicket),
    nextStory: counterOr(board.nextStory, DEFAULT_BOARD_CONFIG.nextStory),
    tiers: { ...DEFAULT_BOARD_CONFIG.tiers, ...entriesFrom(board.tiers, tierFrom) },
    categories: { ...DEFAULT_BOARD_CONFIG.categories, ...entriesFrom(board.categories, categoryFrom) },
    settings: settingsFrom(board.settings),
  }
}

const rejectedNames = (value: unknown, read: (entry: unknown) => unknown): string[] =>
  isRecord(value) ? Object.entries(value).filter(([, entry]) => read(entry) === undefined).map(([name]) => name) : []

const SECTIONS = ['tiers', 'categories', 'settings'] as const
const SETTING_TYPES = { verify: 'string', planReviewPasses: 'number', [NAME_BEFORE_THE_PLAN_SKILL]: 'number', worktrees: 'boolean', unrouted: 'string', checks: 'string', pullRequestDiagram: 'boolean' } as const

const sectionProblems = (board: JsonRecord): string[] =>
  SECTIONS.filter(name => board[name] !== undefined && !isRecord(board[name])).map(
    name => `"${name}" must be an object, so the defaults are used for it.`,
  )

const prefixProblems = (board: JsonRecord): string[] =>
  board.prefix === undefined || prefixFrom(board.prefix).prefix !== undefined
    ? []
    : ['"prefix" must be one to ten letters, like TN, so it is ignored.']

const settingProblems = (settings: unknown): string[] =>
  isRecord(settings)
    ? Object.entries(SETTING_TYPES)
        .filter(([name, type]) => settings[name] !== undefined && typeof settings[name] !== type)
        .map(([name, type]) => `setting "${name}" must be a ${type}, so the default is used.`)
    : []

// A read-back that is dropped without a word would have the session build from tickets a reviewed result no longer
// matches, so a wrong one is named.
const readBackProblems = (step: unknown): string[] =>
  isRecord(step) && step.readBack !== undefined && textOrUndefined(step.readBack) === undefined
    ? ['setting "beforeBuilding.readBack" must be text, so the result of the step is not read back.']
    : []

const beforeBuildingProblems = (settings: unknown): string[] => {
  const step = isRecord(settings) ? settings.beforeBuilding : undefined
  if (step === undefined) return []

  return beforeBuildingFrom(step) === undefined
    ? ['setting "beforeBuilding" must be an object with a label and how as text, so it is ignored.']
    : readBackProblems(step)
}

const sharedProblems = (settings: unknown): string[] => {
  const shared = isRecord(settings) ? settings.shared : undefined
  if (shared === undefined) return []
  if (!isRecord(shared)) return ['setting "shared" must be an object of name to { what, refresh }, so nothing is shared.']

  return rejectedNames(shared, sharedThingFrom).map(
    name => `shared "${name}" needs what as one line of text and refresh as auto, ask or a command, so it is ignored.`,
  )
}

const entryProblems = (board: JsonRecord): string[] => [
  ...rejectedNames(board.tiers, tierFrom).map(name => `tier "${name}" needs a model and an effort, so it is ignored.`),
  ...rejectedNames(board.categories, categoryFrom).map(name => `category "${name}" needs a tier, so it is ignored.`),
]

const unknownTierProblems = (config: BoardConfig): string[] =>
  Object.entries(config.categories)
    .filter(([, category]) => !Object.hasOwn(config.tiers, category.tier))
    .map(([name, category]) => `category "${name}" names tier "${category.tier}", which does not exist.`)

const unknownUnroutedProblems = (settings: BoardSettings, categories: Record<string, Category>): string[] =>
  settings.unrouted === TURNS_OFF_UNROUTED || Object.hasOwn(categories, settings.unrouted)
    ? []
    : [`setting "unrouted" names category "${settings.unrouted}", which does not exist.`]

const parsedOrProblem = (text: string): { parsed: unknown } | { problem: string } => {
  try {
    const parsed: unknown = JSON.parse(text)

    return { parsed }
  } catch (error) {
    return { problem: `the file is not valid JSON (${error instanceof Error ? error.message : 'unreadable'}), so the defaults are in use.` }
  }
}

const recordProblems = (board: JsonRecord): string[] => {
  const config = mergeBoardConfig(board)

  return [
    ...sectionProblems(board),
    ...prefixProblems(board),
    ...entryProblems(board),
    ...settingProblems(board.settings),
    ...sharedProblems(board.settings),
    ...beforeBuildingProblems(board.settings),
    ...unknownTierProblems(config),
    ...unknownUnroutedProblems(config.settings, config.categories),
  ]
}

export const boardConfigProblems = (text: string): string[] => {
  const outcome = parsedOrProblem(text)
  if ('problem' in outcome) return [outcome.problem]

  return isRecord(outcome.parsed) ? recordProblems(outcome.parsed) : ['the file is not a JSON object, so the defaults are in use.']
}

export const serializeBoardConfig = (config: JsonRecord): string => `${JSON.stringify(config, null, 2)}\n`
