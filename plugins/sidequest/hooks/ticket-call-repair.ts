import { isRecord } from './board-config'
import { ENGINE_KEYS } from './tool-input'
import type { JsonRecord } from './tool-input'

export type RepairedCall = { operations: unknown; notes: string[] }

type RepairedOperation = { operation: JsonRecord; note: string }

const FINISH_NOTE = 'op "finish" is not a ticket operation, so it was left out: record a run result with the finish tool (id, outcome, result).'

const MOVE_FIELDS = ['id', 'status']
const NOTE_FIELDS = ['id', 'text', 'note']

const onlyHas = (fields: JsonRecord, allowed: readonly string[]): boolean => Object.keys(fields).every(key => allowed.includes(key))

// Seen in most rigged runs on 2026-11-19: { id, status } or { id, note } with no operations list.
const inferredOperationName = (fields: JsonRecord): string | undefined => {
  if (typeof fields.op === 'string') return fields.op
  if (fields.status !== undefined && onlyHas(fields, MOVE_FIELDS)) return 'move'
  if ((fields.text !== undefined || fields.note !== undefined) && onlyHas(fields, NOTE_FIELDS)) return 'note'

  return undefined
}

const loneOperationFrom = (input: JsonRecord): JsonRecord | undefined => {
  if (input.operations !== undefined) return undefined
  const fields = Object.fromEntries(Object.entries(input).filter(([key]) => !ENGINE_KEYS.includes(key)))
  const name = inferredOperationName(fields)

  return name === undefined ? undefined : { ...fields, op: name }
}

const loneOperationNote = (operation: JsonRecord): string =>
  `The call had no operations list, so it was read as one ${String(operation.op)} operation. Send { "operations": [{ "op": "${String(operation.op)}", ... }] } next time.`

const noteFieldAsText = (operation: JsonRecord): RepairedOperation | undefined => {
  const { note, ...rest } = operation
  if (operation.op !== 'note' || typeof note !== 'string' || operation.text !== undefined) return undefined

  return { operation: { ...rest, text: note }, note: 'A note takes its words in "text", so "note" was read as the text.' }
}

const statusOperationAsMove = (operation: JsonRecord): RepairedOperation | undefined =>
  operation.op === 'status' && operation.status !== undefined
    ? { operation: { ...operation, op: 'move' }, note: 'op "status" was read as op "move": to set a status, send move with id and status.' }
    : undefined

const OPERATION_REPAIRS = [noteFieldAsText, statusOperationAsMove]

const repairedOperation = (operation: unknown): RepairedOperation | undefined => {
  if (!isRecord(operation)) return undefined
  for (const repair of OPERATION_REPAIRS) {
    const repaired = repair(operation)
    if (repaired !== undefined) return repaired
  }

  return undefined
}

const isFinish = (operation: unknown): boolean => isRecord(operation) && operation.op === 'finish'

const repairedOperations = (operations: readonly unknown[]): RepairedCall => {
  const notes: string[] = []
  const kept = operations.filter(operation => !isFinish(operation))
  if (kept.length < operations.length) notes.push(FINISH_NOTE)
  const repaired = kept.map(operation => {
    const result = repairedOperation(operation)
    if (result !== undefined) notes.push(result.note)

    return result?.operation ?? operation
  })

  return { operations: repaired, notes }
}

// A slip in how the call is shaped is bookkeeping: it is read where the meaning is plain and the answer says how. A
// call that is not plain is returned as it came, so it is refused as before.
export const repairedTicketCall = (input: JsonRecord): RepairedCall => {
  const lone = loneOperationFrom(input)
  const operations = lone === undefined ? input.operations : [lone]
  if (!Array.isArray(operations)) return { operations, notes: [] }
  const repaired = repairedOperations(operations)

  return lone === undefined ? repaired : { ...repaired, notes: [loneOperationNote(lone), ...repaired.notes] }
}
