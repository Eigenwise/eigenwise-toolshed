import { isRecord, TURNS_OFF_UNROUTED } from './board-config'
import type { BoardIds } from './board-ids'
import type { SidequestRun } from '../types'
import type { AgentRole, BoardConfig, BoardSettings, Tier } from './board-config'
import type { Ticket } from './tickets'

export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type ClaudeAlias = (typeof CLAUDE_ALIASES)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

const DEFAULT_FALLBACK: ClaudeAlias = 'sonnet'
const ROUTE_TAG = /\[route:([a-z][a-z0-9-]*)\]/

export type RouteRequest = { ticket?: string; category?: string; isUnrouted?: true; keepsOwnModel?: true }

export type Providers = { modelIds: readonly string[]; fallback?: ClaudeAlias }

export const NO_PROVIDERS: Providers = { modelIds: [] }

export type Route = {
  category: string
  tier: string
  role: AgentRole
  requestedModel: string
  model: string
  effort: string
  reason?: string
}

// The brief opens with `Ticket SQ-12:` and a workflow stage with `SQ-12 [route:review]`, in the board's own prefix. A
// ref further in is a mention, as in "compare SQ-3 and SQ-4", and routes nothing. A prefix is letters only, so it needs
// no escaping.
const leadingTicketRefOn = (ids: BoardIds): RegExp => new RegExp(`^\\s*(?:Ticket\\s+)?(${ids.ticketPrefix}\\d+)\\b`)

export const leadingTicketRefIn = (prompt: string, ids: BoardIds): string | undefined => leadingTicketRefOn(ids).exec(prompt)?.[1]

const TAG_AT_START = /^\s*\[route:([a-z][a-z0-9-]*)\]/

// Where a brief or a lookup puts the tag: first, or straight after the leading ticket ref. A tag further in is text,
// as when a ticket's What quotes `[route:review]`. The description is short and the caller's own, so a tag in it counts.
export const routeTagIn = (prompt: string, description: string, ids: BoardIds): string | undefined => {
  const afterRef = prompt.replace(leadingTicketRefOn(ids), '')

  return TAG_AT_START.exec(prompt)?.[1] ?? TAG_AT_START.exec(afterRef)?.[1] ?? ROUTE_TAG.exec(description)?.[1]
}

export const routeRequestIn = (prompt: string, description: string, ids: BoardIds): RouteRequest | undefined => {
  const ticket = leadingTicketRefIn(prompt, ids)
  const category = routeTagIn(prompt, description, ids)
  if (ticket === undefined && category === undefined) return undefined

  return { ...(ticket ? { ticket } : {}), ...(category ? { category } : {}) }
}

// The spawn hook never sees an agent's definition, so only types known to name no model and no effort of their own
// get a model and an effort. Any other type may name one, and its own choice wins. A user or project agent may
// reuse a built-in's name with a model of its own, so a built-in name counts only when the engine provides it.
// `workflow-subagent` and `teammate` are what an agent reports when its call named no type at all.
const BUILT_IN_TYPES_WITHOUT_OWN_MODEL = ['general-purpose', 'Explore', 'Plan']
const UNTYPED_SPAWNS = ['workflow-subagent', 'teammate']
const FAN_OUT_TYPES = ['general-purpose', 'workflow-subagent']

export type SpawnShape = { subagentType: string; isEngineProvided: boolean; namesModel: boolean; isFork: boolean }

export const namesNoModelOfItsOwn = (shape: Pick<SpawnShape, 'subagentType' | 'isEngineProvided'>): boolean =>
  UNTYPED_SPAWNS.includes(shape.subagentType) ||
  shape.subagentType.startsWith('sidequest:') ||
  (shape.isEngineProvided && BUILT_IN_TYPES_WITHOUT_OWN_MODEL.includes(shape.subagentType))

export const isClaudeAlias = (model: string): model is ClaudeAlias => CLAUDE_ALIASES.some(alias => alias === model)

export const effortLevelOf = (effort: string): EffortLevel | undefined => EFFORT_LEVELS.find(level => level === effort)

const isKnownModel = (model: string, providers: Providers): boolean => isClaudeAlias(model) || providers.modelIds.includes(model)

type Fallback = { model: string; source: string }

const fallbackOf = (tier: Tier, providers: Providers): Fallback => {
  if (tier.fallback !== undefined && isKnownModel(tier.fallback, providers)) return { model: tier.fallback, source: 'the tier fallback' }
  if (providers.fallback !== undefined) return { model: providers.fallback, source: 'the provider fallback' }

  return { model: DEFAULT_FALLBACK, source: 'no usable fallback is set' }
}

const unknownModelReason = (tierName: string, tier: Tier, fallback: Fallback): string =>
  `tier ${tierName} names model "${tier.model}", which is neither a Claude alias nor listed by a provider file, so it runs on ${fallback.model} (${fallback.source})`

const modelForTier = (tierName: string, tier: Tier, providers: Providers): Pick<Route, 'model' | 'reason'> => {
  if (isKnownModel(tier.model, providers)) return { model: tier.model }
  const fallback = fallbackOf(tier, providers)

  return { model: fallback.model, reason: unknownModelReason(tierName, tier, fallback) }
}

export const resolveRoute = (category: string, config: BoardConfig, providers: Providers): Route | undefined => {
  const definition = config.categories[category]
  const tier = definition ? config.tiers[definition.tier] : undefined
  if (!definition || !tier) return undefined

  return {
    category,
    tier: definition.tier,
    role: definition.role,
    requestedModel: tier.model,
    effort: tier.effort,
    ...modelForTier(definition.tier, tier, providers),
  }
}

export const DEFAULT_CATEGORY = 'build'

export const hasRoute = (category: string, config: BoardConfig): boolean => {
  const definition = config.categories[category]

  return definition !== undefined && config.tiers[definition.tier] !== undefined
}

// The category a ticket runs on when its own has no route: build, else the unrouted one, else any that routes.
export const fallbackCategoryOf = (config: BoardConfig): string | undefined =>
  [DEFAULT_CATEGORY, config.settings.unrouted, ...Object.keys(config.categories)].find(category => hasRoute(category, config))

export type SpawnRoute = { route: Route; ticket?: string; isUnrouted?: true; keepsOwnModel?: true }

const spawnMarksOf = (request: RouteRequest): Pick<SpawnRoute, 'isUnrouted' | 'keepsOwnModel'> => ({
  ...(request.isUnrouted ? { isUnrouted: true } : {}),
  ...(request.keepsOwnModel ? { keepsOwnModel: true } : {}),
})

export const spawnRouteFor = (
  request: RouteRequest,
  config: BoardConfig,
  ticket: Ticket | undefined,
  providers: Providers,
): SpawnRoute | undefined => {
  const category = request.category ?? ticket?.category
  const route = category === undefined ? undefined : resolveRoute(category, config, providers)
  if (!route) return undefined

  return { route, ...(ticket ? { ticket: ticket.id } : {}), ...spawnMarksOf(request) }
}

// A workflow script that names an agent type gets that type's own model, so a workflow agent counts as fan-out only
// by its type, like any other spawn.
const isFanOutAgentType = (subagentType: string): boolean =>
  FAN_OUT_TYPES.includes(subagentType) || subagentType.startsWith('sidequest:')

export const isUnroutedFanOut = (shape: SpawnShape): boolean =>
  !shape.namesModel && !shape.isFork && isFanOutAgentType(shape.subagentType)

export const unroutedRequestFor = (shape: SpawnShape, settings: BoardSettings): RouteRequest | undefined =>
  isUnroutedFanOut(shape) && settings.unrouted !== TURNS_OFF_UNROUTED ? { category: settings.unrouted, isUnrouted: true } : undefined

export const routeRequestFor = (
  prompt: string,
  description: string,
  shape: SpawnShape,
  settings: BoardSettings,
  ids: BoardIds,
): RouteRequest | undefined => {
  const request = routeRequestIn(prompt, description, ids)
  if (namesNoModelOfItsOwn(shape)) return request ?? unroutedRequestFor(shape, settings)

  return request ? { ...request, keepsOwnModel: true } : undefined
}

export const setsModelAndEffort = (spawn: SpawnRoute | undefined): spawn is SpawnRoute =>
  spawn !== undefined && spawn.keepsOwnModel === undefined

// A ticket's log carries the fallback reason. A spawn with no ticket has nowhere else to say it.
export const fallbackReasonToAnnounce = (spawn: SpawnRoute, callerModel: string | undefined): string | undefined =>
  spawn.ticket === undefined && callerModel === undefined && setsModelAndEffort(spawn) ? spawn.route.reason : undefined

const NOT_REQUESTED = 'none'
const OWN_EFFORT = 'own'

const requestedOf = (spawn: SpawnRoute, callerModel: string | undefined): Pick<SidequestRun, 'requestedModel' | 'effort'> =>
  spawn.keepsOwnModel
    ? { requestedModel: callerModel ?? NOT_REQUESTED, effort: OWN_EFFORT }
    : { requestedModel: callerModel ?? spawn.route.requestedModel, effort: spawn.route.effort }

export const routedRunOf = (spawn: SpawnRoute, model: string, callerModel: string | undefined): SidequestRun => ({
  ...(spawn.ticket ? { ticket: spawn.ticket } : {}),
  category: spawn.route.category,
  model,
  ...requestedOf(spawn, callerModel),
})

export const spawnLogReason = (spawn: SpawnRoute, subagentType: string, callerModel: string | undefined): string | undefined => {
  if (spawn.keepsOwnModel) return `agent type ${subagentType} may name its own model, so routing left it alone`

  return callerModel === undefined ? spawn.route.reason : undefined
}

export const spawnLogLine = (agentId: string, run: SidequestRun, reason: string | undefined): string => {
  const line = `agent ${agentId} ${run.category} requested ${run.requestedModel}/${run.effort} resolved ${run.model}`

  return reason ? `${line}. ${reason}` : line
}

export const shortModelName = (model: string): string => CLAUDE_ALIASES.find(alias => model.includes(alias)) ?? model

const rerouteFacts = (count: number, model: string, category: string): string =>
  `${count} untagged ${count === 1 ? 'agent' : 'agents'} ran on ${shortModelName(model)}, the ${category} route.`

export const rerouteContextLine = (count: number, model: string, category: string): string =>
  `Sidequest: ${rerouteFacts(count, model, category)} Start an agent's prompt with [route:<category>] to pick another.`

export const fallbackToast = (reasons: readonly string[]): string =>
  `An agent ran on a backup model because ${reasons.join('; ')}. /sidequest:setup picks a model you have.`

const modelIdOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined

export const providerModelIds = (providerFile: unknown): string[] => {
  const models = isRecord(providerFile) && Array.isArray(providerFile.models) ? providerFile.models : []

  return models.map(modelIdOf).filter((id): id is string => id !== undefined)
}

const providerFallbackOf = (providerFile: unknown): ClaudeAlias | undefined => {
  const fallback = isRecord(providerFile) ? providerFile.fallback : undefined

  return typeof fallback === 'string' && isClaudeAlias(fallback) ? fallback : undefined
}

// Several provider files may each name a fallback; the first in file-name order is used, so the choice is stable.
export const providersOf = (providerFiles: readonly unknown[]): Providers => {
  const fallback = providerFiles.map(providerFallbackOf).find(alias => alias !== undefined)

  return { modelIds: providerFiles.flatMap(providerModelIds), ...(fallback ? { fallback } : {}) }
}
