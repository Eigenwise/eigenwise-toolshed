import type { RoutedRun, SpawnRow, SpawnStart } from '../types'

const withRouting = (spawn: SpawnStart, run: RoutedRun | undefined): SpawnRow => ({
  ...spawn,
  ticket: run?.ticket,
  category: run?.category,
  model: run?.model,
  requestedModel: run?.requestedModel,
})

// Without Sidequest's published runs there is nothing to join, and the ledger says nothing about routing.
export function joinSpawns(spawns: SpawnStart[], runs: Record<string, RoutedRun> | undefined): SpawnRow[] | undefined {
  if (runs === undefined || spawns.length === 0) return undefined
  return spawns.map(spawn => withRouting(spawn, runs[spawn.agentId]))
}
